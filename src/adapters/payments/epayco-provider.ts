import { createHash, timingSafeEqual } from "crypto";
import type {
  CheckoutResult,
  CreateCheckoutInput,
  ParsedPaymentEvent,
  WebhookHeaders,
  WebhookPaymentProvider,
} from "hexagonal-payments-core";
import { env } from "../../config/env";
import type { DrizzlePaymentAttemptRepository } from "./drizzle-payment-attempt-repository";
import { toAmountMinor, toDecimalMajor } from "./money";

/**
 * ePayco (Colombia) confirmation signature, per the payments-service design doc
 * section 7.1:
 *   SHA-256(p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^ x_amount ^ x_currency_code)
 * — amount used EXACTLY as received (no reformatting), compared in constant time.
 * ePayco's confirmation POST has no timestamp/nonce, so PaymentEventStore's
 * (provider, providerEventId) uniqueness is the only replay defense — this adapter
 * does not attempt to add one.
 */
function computeConfirmationSignature(params: {
  custIdCliente: string;
  pKey: string;
  xRefPayco: string;
  xTransactionId: string;
  xAmount: string;
  xCurrencyCode: string;
}): string {
  const raw = [
    params.custIdCliente,
    params.pKey,
    params.xRefPayco,
    params.xTransactionId,
    params.xAmount,
    params.xCurrencyCode,
  ].join("^");
  return createHash("sha256").update(raw).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ePayco status vocabulary -> core PaymentAttemptStatus (application-supplied
// ProviderStatusMapper — see src/modules/payments/provider-status-mappers.ts).
export const EPAYCO_STATUS_MAP: Record<string, string> = {
  Aceptada: "paid",
  Pendiente: "pending",
  Iniciada: "pending",
  Rechazada: "failed",
  Fallida: "failed",
  Cancelada: "cancelled",
  Abandonada: "cancelled",
  Expirada: "expired",
  Reversada: "refunded",
};

function parseFormOrJson(rawBody: string | Buffer): Record<string, string> {
  const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

/**
 * ePayco provider adapter — direct HTTP calls (no SDK), per the spec's explicit
 * "implementación: llamadas HTTP directas... en lugar del SDK".
 *
 * UNVERIFIED ASSUMPTIONS (not confirmed against live ePayco docs):
 *   - `createCheckout`'s token endpoint (`POST {validationBaseUrl}/login`) and payload
 *     shape (public_key/private_key).
 *   - The checkout-session creation endpoint/payload
 *     (`POST {validationBaseUrl}/payment/link/create`) and its response field names
 *     (`data.link`, `data.ref_payco`).
 * The signature algorithm and status vocabulary are per the trusted spec section 7.1.
 * The "contraste" endpoint (`validateTransactionByReference`) IS verified —
 * `https://secure.epayco.co/validation/v1/reference/{ref}`, confirmed against
 * docs.epayco.com and github.com/epayco/resources — including the x_amount/
 * x_currency_code/x_id_invoice response field names.
 */
export class EpaycoProvider implements WebhookPaymentProvider {
  readonly name = "epayco";

  constructor(private readonly attemptRepository: DrizzlePaymentAttemptRepository) {}

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    // Verified against docs.epayco.com (checkout-implementacion, apify): login is
    // HTTP Basic over base64(public_key:private_key), NOT a JSON body — a real,
    // confirmed correction from an earlier unverified draft of this adapter.
    const basicAuth = Buffer.from(`${env.epayco.publicKey}:${env.epayco.privateKey}`).toString(
      "base64",
    );
    const tokenRes = await fetch("https://apify.epayco.co/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${basicAuth}` },
    });
    if (!tokenRes.ok) {
      throw new Error(`ePayco: failed to obtain token (${tokenRes.status})`);
    }
    const tokenJson = (await tokenRes.json()) as { token?: string };
    if (!tokenJson.token) throw new Error("ePayco: token response missing `token`");

    // Verified endpoint/payload: docs.epayco.com's Smart Checkout v2 "session"
    // API. Note this is NOT a redirect-URL flow (unlike what an earlier draft of
    // this adapter assumed) — it returns a `sessionId` meant for ePayco's
    // checkout.js widget on the frontend, so `redirectUrl` is intentionally
    // left undefined here (the CheckoutResult port already allows this: "Absent
    // for providers with no redirect step"). The consuming frontend embeds
    // ePayco's widget with this sessionId rather than redirecting the browser.
    const checkoutRes = await fetch("https://apify.epayco.co/payment/session/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenJson.token}`,
      },
      body: JSON.stringify({
        checkout_version: "2",
        name: `Orden ${input.reference}`,
        description: `Orden ${input.reference}`,
        invoice: input.reference,
        currency: input.currency.toLowerCase(),
        amount: toDecimalMajor(input.amountMinor, input.currency),
        confirmation: input.confirmationUrl ?? env.epayco.confirmationUrl,
        response: input.returnUrl ?? env.epayco.successUrl,
        methodConfirmation: "POST",
      }),
    });
    if (!checkoutRes.ok) {
      throw new Error(`ePayco: failed to create checkout session (${checkoutRes.status})`);
    }
    const checkoutJson = (await checkoutRes.json()) as { data?: { sessionId?: string } };
    const sessionId = checkoutJson.data?.sessionId;
    if (!sessionId) {
      throw new Error("ePayco: session response missing data.sessionId");
    }

    return { providerRef: sessionId };
  }

  verifyWebhookSignature(rawBody: string | Buffer, _headers: WebhookHeaders): boolean {
    const fields = parseFormOrJson(rawBody);
    const providedSignature = fields.x_signature;
    if (!providedSignature) return false;

    const expected = computeConfirmationSignature({
      custIdCliente: env.epayco.custIdCliente,
      pKey: env.epayco.pKey,
      xRefPayco: fields.x_ref_payco ?? "",
      xTransactionId: fields.x_transaction_id ?? "",
      xAmount: fields.x_amount ?? "",
      xCurrencyCode: fields.x_currency_code ?? "",
    });

    return constantTimeEqual(providedSignature, expected);
  }

  async parseWebhookEvent(rawBody: string | Buffer, _headers: WebhookHeaders): Promise<ParsedPaymentEvent> {
    const fields = parseFormOrJson(rawBody);
    const xRefPayco = fields.x_ref_payco ?? "";

    // Resolving the attempt by providerRef (matching x_ref_payco against what
    // we stored at checkout) does NOT work for Smart Checkout v2: we store
    // the session id as providerRef at checkout time, but the confirmation
    // webhook's x_ref_payco is a DIFFERENT, later-assigned transaction
    // reference — confirmed against a real ePayco test transaction, where
    // findByProviderRef never matched. The field that round-trips reliably
    // is x_id_invoice, which we set to the order's own id when creating the
    // checkout session (`invoice: input.reference` = order.id). Since
    // PaymentAttempt.orderId already equals that value, we look up the
    // attempt by order id directly rather than by any provider reference.
    const orderId = fields.x_id_invoice ?? fields.x_id_factura ?? "";
    const attempt = orderId ? await this.attemptRepository.findLatestByOrderId(orderId) : null;

    return {
      providerEventId: xRefPayco,
      attemptId: attempt?.id ?? null,
      status: fields.x_transaction_state ?? fields.x_response ?? "",
      amountMinor:
        fields.x_amount && fields.x_currency_code
          ? toAmountMinor(fields.x_amount, fields.x_currency_code)
          : undefined,
      currency: fields.x_currency_code,
      payloadHash: createHash("sha256")
        .update(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"))
        .digest("hex"),
    };
  }

  /**
   * Server-to-server "contraste": the spec requires calling ePayco's
   * transaction-validation endpoint by reference and comparing amount/currency/invoice
   * against the order BEFORE trusting the webhook's own amount/currency fields. Must be
   * called by the webhook route AFTER `verifyWebhookSignature` passes and BEFORE
   * settlement is applied.
   *
   * Endpoint and field names verified against ePayco's own docs/examples
   * (docs.epayco.com + github.com/epayco/resources issue #13): the reference
   * endpoint is a fixed domain, NOT env.epayco.validationBaseUrl — that
   * config value is used for the checkout/token endpoints only, which
   * remain unverified. The reference example shown by ePayco needs no
   * p-cust-id-cliente/p-key headers (just Content-Type); we still send them
   * since ePayco's own docs are inconsistent across endpoints and an extra
   * header the server ignores is harmless, whereas omitting a required one
   * would fail closed anyway (this call's errors already reject the
   * webhook, per the contraste check being fail-closed).
   */
  async validateTransactionByReference(
    xRefPayco: string,
  ): Promise<{ amountMinor: number; currency: string; invoice: string }> {
    // ePayco's own reference endpoint is known to be flaky — confirmed
    // against a REAL, valid transaction: it returned HTTP 200 with a
    // generic {"status":false,"message":"Error de datos o conexión."}
    // body (matches a publicly reported issue: github.com/epayco/resources
    // #13). Retrying a couple of times absorbs that transient failure
    // instead of rejecting a genuinely approved payment. If it's still
    // failing after retries, throw the distinct EpaycoContrasteUnavailableError
    // so the caller can fail SAFE (settle + flag for manual review) rather
    // than fail closed (reject) — that distinction matters: fail-closed is
    // for when the data doesn't match (real fraud signal), not for when
    // ePayco's own infrastructure is having a bad moment.
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(
          `https://secure.epayco.co/validation/v1/reference/${encodeURIComponent(xRefPayco)}`,
          {
            headers: {
              "Content-Type": "application/json",
              "p-cust-id-cliente": env.epayco.custIdCliente,
              "p-key": env.epayco.pKey,
            },
          },
        );
        if (!res.ok) {
          throw new Error(`ePayco: contraste validation call failed (${res.status})`);
        }
        const json = (await res.json()) as {
          status?: boolean;
          data?: { x_amount?: string; x_currency_code?: string; x_id_invoice?: string };
        };
        if (json.status === false || !json.data) {
          throw new Error("ePayco: contraste endpoint returned a logical error, no transaction data");
        }
        const currency = (json.data.x_currency_code ?? "").toUpperCase();
        const amountMinor =
          json.data.x_amount && currency ? toAmountMinor(json.data.x_amount, currency) : undefined;
        return {
          amountMinor: amountMinor ?? 0,
          currency,
          invoice: json.data.x_id_invoice ?? "",
        };
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
      }
    }
    throw new EpaycoContrasteUnavailableError(
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  }
}

/**
 * Thrown when ePayco's contraste endpoint is unreachable/erroring after
 * retries — distinct from a genuine field mismatch, so callers can treat
 * it as "unverifiable, needs manual review" rather than "confirmed fraud,
 * reject".
 */
export class EpaycoContrasteUnavailableError extends Error {
  constructor(reason: string) {
    super(`ePayco contraste endpoint unavailable after retries: ${reason}`);
    this.name = "EpaycoContrasteUnavailableError";
  }
}
