import { createHash } from "crypto";
import {
  Client,
  Environment,
  CheckoutPaymentIntent,
  OrdersController,
} from "@paypal/paypal-server-sdk";
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

// PayPal status vocabulary (Orders v2 + webhook `resource.status` /
// `event_type`-derived) -> core PaymentAttemptStatus. See
// src/modules/payments/provider-status-mappers.ts for how this is wired in.
export const PAYPAL_STATUS_MAP: Record<string, string> = {
  COMPLETED: "paid",
  APPROVED: "pending",
  CREATED: "pending",
  SAVED: "pending",
  PAYER_ACTION_REQUIRED: "pending",
  VOIDED: "cancelled",
  DECLINED: "failed",
};

/**
 * PayPal provider adapter, reusing the already-installed `@paypal/paypal-server-sdk`
 * (a repo dependency left over from the deleted POC checkout) for order creation, and
 * direct HTTP for webhook-signature verification: this SDK version
 * (@paypal/paypal-server-sdk@2.4.0) ships Orders/Payments/Subscriptions/Vault/
 * TransactionSearch controllers only — no notifications/webhooks controller — so
 * `verifyWebhookSignature` calls PayPal's REST
 * `POST /v1/notifications/verify-webhook-signature` endpoint directly, per PayPal's
 * own webhook-verification docs (this call shape IS documented/stable PayPal REST API,
 * not an assumption — unlike ePayco's endpoints, which are flagged unverified).
 */
export class PaypalProvider implements WebhookPaymentProvider {
  readonly name = "paypal";

  private readonly client: Client;
  private readonly ordersController: OrdersController;
  private readonly apiBaseUrl: string;

  constructor(private readonly attemptRepository: DrizzlePaymentAttemptRepository) {
    this.apiBaseUrl =
      env.paypal.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

    this.client = new Client({
      environment: env.paypal.mode === "live" ? Environment.Production : Environment.Sandbox,
      clientCredentialsAuthCredentials: {
        oAuthClientId: env.paypal.clientId,
        oAuthClientSecret: env.paypal.clientSecret,
      },
    });
    this.ordersController = new OrdersController(this.client);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const { result } = await this.ordersController.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: input.reference,
            invoiceId: input.reference,
            amount: {
              currencyCode: input.currency,
              value: toDecimalMajor(input.amountMinor, input.currency),
            },
          },
        ],
        applicationContext: {
          returnUrl: input.returnUrl ?? env.paypal.successUrl,
          cancelUrl: input.cancelUrl ?? env.paypal.cancelUrl,
        },
      },
    });

    const approveLink = result.links?.find((l) => l.rel === "approve")?.href;
    if (!result.id) throw new Error("PayPal: createOrder response missing id");

    return { redirectUrl: approveLink, providerRef: result.id };
  }

  /**
   * PayPal's Orders v2 API with intent=CAPTURE does NOT move money on buyer
   * approval alone — approval only authorizes the order; an explicit
   * capture call is required afterward, normally triggered by the
   * frontend on return from PayPal (the `token` query param IS the
   * PayPal order id). Without this, no COMPLETED webhook is ever fired
   * and the payment stays approved-but-uncaptured forever. This is a
   * synchronous best-effort trigger only — the actual settlement (credits,
   * email, etc.) still happens through the normal webhook path once
   * PayPal's CHECKOUT.ORDER.APPROVED / PAYMENT.CAPTURE.COMPLETED event
   * arrives, so this method deliberately does not duplicate that logic.
   */
  async captureOrder(paypalOrderId: string): Promise<{ status: string }> {
    try {
      const { result } = await this.ordersController.captureOrder({ id: paypalOrderId });
      return { status: result.status ?? "" };
    } catch (err) {
      // The frontend re-triggers this on every page load where the order is
      // still "open" in OUR db — if PayPal's own webhook hasn't landed yet
      // (a real race, not a bug) and the buyer reloads, a second capture
      // call lands here. PayPal correctly rejects it (money already moved),
      // which is success from our side too, not a failure — treat it as one
      // instead of bubbling a 502 the page has no way to recover from.
      const details = (err as { result?: { details?: Array<{ issue?: string }> } })?.result?.details;
      const alreadyCaptured = details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
      if (alreadyCaptured) return { status: "COMPLETED" };
      throw err;
    }
  }

  private async oauthToken(): Promise<string> {
    const res = await fetch(`${this.apiBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${env.paypal.clientId}:${env.paypal.clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal: failed to obtain OAuth token (${res.status})`);
    const json = (await res.json()) as { access_token: string };
    return json.access_token;
  }

  async verifyWebhookSignature(rawBody: string | Buffer, headers: WebhookHeaders): Promise<boolean> {
    if (!env.paypal.webhookId) return false;

    const bodyText = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const header = (name: string): string | undefined => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    const token = await this.oauthToken();
    const res = await fetch(`${this.apiBaseUrl}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        auth_algo: header("paypal-auth-algo"),
        cert_url: header("paypal-cert-url"),
        transmission_id: header("paypal-transmission-id"),
        transmission_sig: header("paypal-transmission-sig"),
        transmission_time: header("paypal-transmission-time"),
        webhook_id: env.paypal.webhookId,
        webhook_event: JSON.parse(bodyText),
      }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { verification_status?: string };
    return json.verification_status === "SUCCESS";
  }

  async parseWebhookEvent(rawBody: string | Buffer, _headers: WebhookHeaders): Promise<ParsedPaymentEvent> {
    const bodyText = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const event = JSON.parse(bodyText) as {
      id: string;
      resource?: {
        id?: string;
        status?: string;
        supplementary_data?: { related_ids?: { order_id?: string } };
        amount?: { value?: string; currency_code?: string };
      };
    };

    // Capture events reference the order via supplementary_data.related_ids.order_id;
    // order-status events reference it via resource.id directly.
    const paypalOrderId = event.resource?.supplementary_data?.related_ids?.order_id ?? event.resource?.id;
    const attempt = paypalOrderId ? await this.attemptRepository.findByProviderRef(paypalOrderId) : null;

    return {
      providerEventId: event.id,
      attemptId: attempt?.id ?? null,
      status: event.resource?.status ?? "",
      amountMinor:
        event.resource?.amount?.value && event.resource?.amount?.currency_code
          ? toAmountMinor(event.resource.amount.value, event.resource.amount.currency_code)
          : undefined,
      currency: event.resource?.amount?.currency_code,
      payloadHash: createHash("sha256").update(bodyText).digest("hex"),
    };
  }
}
