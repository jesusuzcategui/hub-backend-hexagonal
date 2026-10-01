import { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import {
  checkout,
  attachManualTransferProof,
  handleEpaycoWebhook,
  handlePaypalWebhook,
  getPublicOrderStatus,
  capturePaypalOrder,
  listOrdersForStudent,
  listPaymentMethods,
  type PaymentMethod,
} from "./payments.service";

const VALID_METHODS: PaymentMethod[] = ["epayco", "paypal", "manual_transfer"];

// POST /checkout — public, no auth. Accepts either a plain JSON body (epayco/paypal)
// or a multipart/form-data body carrying the manual-transfer proof file alongside the
// same fields.
export async function checkoutController(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let cartToken: string | undefined;
  let paymentMethod: string | undefined;
  let couponCode: string | undefined;
  let proofFile: { filename: string; buffer: Buffer } | undefined;

  if (request.isMultipart()) {
    const file = await request.file();
    if (!file) throw new AppError(400, "MISSING_FILE", "Proof file is required for manual_transfer");
    proofFile = { filename: file.filename, buffer: await file.toBuffer() };

    const fields = file.fields;
    const readField = (name: string): string | undefined => {
      const f = fields[name];
      if (!f || Array.isArray(f)) return undefined;
      return f.type === "field" ? String(f.value) : undefined;
    };
    cartToken = readField("cartToken");
    paymentMethod = readField("paymentMethod");
    couponCode = readField("couponCode");
  } else {
    const body = (request.body ?? {}) as { cartToken?: string; paymentMethod?: string; couponCode?: string };
    cartToken = body.cartToken;
    paymentMethod = body.paymentMethod;
    couponCode = body.couponCode;
  }

  if (!cartToken || !paymentMethod) {
    throw new AppError(400, "MISSING_FIELDS", "cartToken and paymentMethod are required");
  }
  if (!VALID_METHODS.includes(paymentMethod as PaymentMethod)) {
    throw new AppError(400, "INVALID_PAYMENT_METHOD", "paymentMethod must be epayco, paypal, or manual_transfer");
  }
  if (paymentMethod === "manual_transfer" && !proofFile) {
    throw new AppError(400, "MISSING_FILE", "Proof file is required for manual_transfer");
  }

  const result = await checkout(request.server, {
    cartToken,
    paymentMethod: paymentMethod as PaymentMethod,
    couponCode,
  });

  if (paymentMethod === "manual_transfer" && proofFile) {
    await attachManualTransferProof(request.server, result.attemptId, proofFile);
    reply.status(200).send({ data: { status: "awaiting_verification", orderId: result.orderId } });
    return;
  }

  reply
    .status(200)
    .send({ data: { redirectUrl: result.redirectUrl, providerRef: result.providerRef } });
}

export async function epaycoWebhookController(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  try {
    await handleEpaycoWebhook(request.server, rawBody, request.headers as never);
  } catch (err) {
    if (err instanceof AppError) {
      request.log.warn({ err }, "ePayco webhook rejected");
    } else {
      request.log.error({ err }, "ePayco webhook processing failed");
    }
  }
  // Webhooks always 200 so the provider does not retry-storm us — errors are logged above.
  reply.status(200).send({ ok: true });
}

export async function paypalWebhookController(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  try {
    await handlePaypalWebhook(request.server, rawBody, request.headers as never);
  } catch (err) {
    if (err instanceof AppError) {
      request.log.warn({ err }, "PayPal webhook rejected");
    } else {
      request.log.error({ err }, "PayPal webhook processing failed");
    }
  }
  reply.status(200).send({ ok: true });
}

// GET /order/:id — public, no auth. Thank-you page reads order status from here
// instead of trusting a query-string status param (which a buyer could edit by hand).
export async function publicOrderStatusController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { id } = request.params as { id: string };
  const data = await getPublicOrderStatus(request.server, id);
  reply.status(200).send({ data });
}

// GET /orders/my — authenticated, scoped to the caller's own orders.
export async function myOrdersController(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const data = await listOrdersForStudent(request.server, request.user.sub as string);
  reply.status(200).send({ data });
}

// GET /payment-methods — public, no auth. The storefront needs this before
// checkout to know which buttons to show.
export async function paymentMethodsController(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const data = await listPaymentMethods(request.server);
  reply.status(200).send({ data });
}

// POST /paypal/capture/:paypalOrderId — public, no auth (same trust model as
// /checkout — no session exists yet at this point in the flow). Called by the
// frontend when the browser returns from PayPal with `?token=<paypalOrderId>`.
export async function paypalCaptureController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { paypalOrderId } = request.params as { paypalOrderId: string };
  const data = await capturePaypalOrder(request.server, paypalOrderId);
  reply.status(200).send({ data });
}
