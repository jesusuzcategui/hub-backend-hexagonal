import { createHmac, timingSafeEqual } from "crypto";
import { FastifyRequest, FastifyReply } from "fastify";
import { createCheckoutSchema } from "./checkout.schemas";
import { createCheckout, listUserOrders, grantClassCredits, failOrder, logPayment } from "./checkout.service";
import { capturePaypalOrder, verifyPaypalWebhookSignature } from "./providers/paypal";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";
import { orders } from "../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function createCheckoutController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = createCheckoutSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message } });
    return;
  }

  const result = await createCheckout(request.server, request.user.sub, parsed.data);
  reply.status(201).send({ data: result });
}

export async function checkoutSuccessController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const query = request.query as { token?: string };

  if (!query.token) {
    reply.status(200).send({ ok: true });
    return;
  }

  const ppOrderId = query.token;

  const order = await request.server.drizzle.query.orders.findFirst({
    where: sql`${orders.metadata}->>'ppOrderId' = ${ppOrderId}`,
    columns: { id: true, userId: true, totalCents: true, currency: true },
  });

  if (!order) {
    reply.status(200).send({ ok: true });
    return;
  }

  try {
    const status = await capturePaypalOrder(ppOrderId);

    await logPayment(request.server, {
      userId: order.userId,
      orderId: order.id,
      gateway: "paypal",
      externalId: ppOrderId,
      status: status === "COMPLETED" ? "approved" : "pending",
      amountCents: order.totalCents,
      currency: order.currency,
      rawWebhook: { ppOrderId, captureStatus: status },
    });

    if (status === "COMPLETED") {
      await grantClassCredits(request.server, order.id);
    }
  } catch (err) {
    request.server.log.error(err, "PayPal capture error");
  }

  reply.status(200).send({ ok: true });
}

export async function listOrdersController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const data = await listUserOrders(request.server, request.user.sub);
  reply.status(200).send({ data });
}

// ─── MercadoPago Webhook ──────────────────────────────────────────────────────

export async function mpWebhookController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const xSignature = request.headers["x-signature"] as string | undefined;
  const xRequestId = request.headers["x-request-id"] as string | undefined;
  const body = request.body as { action?: string; data?: { id?: string } };
  const dataId = body?.data?.id;

  if (!dataId) {
    reply.status(401).send({ error: { code: "MISSING_SIGNATURE", message: "Missing signature" } });
    return;
  }

  if (!xSignature) {
    reply.status(401).send({ error: { code: "MISSING_SIGNATURE", message: "Missing signature" } });
    return;
  }

  const tsMatch = xSignature.match(/ts=([^,]+)/);
  const v1Match = xSignature.match(/v1=([^,]+)/);
  const ts = tsMatch?.[1];
  const v1 = v1Match?.[1];

  if (!ts || !v1) {
    reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Malformed x-signature header" } });
    return;
  }

  const manifest = `id:${dataId};request-id:${xRequestId ?? ""};ts:${ts};`;
  const expected = createHmac("sha256", env.mercadopago.webhookSecret).update(manifest).digest("hex");
  const vBuf = Buffer.from(v1, "hex");
  const eBuf = Buffer.from(expected, "hex");
  if (vBuf.length !== eBuf.length || !timingSafeEqual(vBuf, eBuf)) {
    reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Signature mismatch" } });
    return;
  }

  if (body?.action !== "payment.updated" && body?.action !== "payment.created") {
    reply.status(200).send({ ok: true });
    return;
  }

  if (!dataId) {
    reply.status(200).send({ ok: true });
    return;
  }

  try {
    // Fetch payment details from MP API
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { Authorization: `Bearer ${env.mercadopago.accessToken}` },
    });
    const payment = await mpRes.json() as {
      id: string;
      status: string;
      external_reference: string;
      transaction_amount: number;
      currency_id: string;
    };

    const orderId = payment.external_reference;
    if (!orderId) {
      reply.status(200).send({ ok: true });
      return;
    }

    const order = await request.server.drizzle.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { id: true, userId: true, totalCents: true, currency: true },
    });

    if (!order) {
      reply.status(200).send({ ok: true });
      return;
    }

    await logPayment(request.server, {
      userId: order.userId,
      orderId: order.id,
      gateway: "mercadopago",
      externalId: String(payment.id),
      status: payment.status === "approved" ? "approved" : payment.status === "rejected" ? "rejected" : "pending",
      amountCents: order.totalCents,
      currency: order.currency,
      rawWebhook: payment,
    });

    if (payment.status === "approved") {
      await grantClassCredits(request.server, order.id);
    } else if (payment.status === "rejected" || payment.status === "cancelled") {
      await failOrder(request.server, order.id);
    }
  } catch (err) {
    request.server.log.error(err, "MP webhook processing error");
  }

  reply.status(200).send({ ok: true });
}

// ─── PayPal Webhook ───────────────────────────────────────────────────────────

export async function paypalWebhookController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body as {
    event_type?: string;
    resource?: {
      id?: string;
      status?: string;
      purchase_units?: Array<{ reference_id?: string; amount?: { value?: string; currency_code?: string } }>;
    };
  };

  const transmissionId = request.headers["paypal-transmission-id"] as string | undefined;
  const transmissionTime = request.headers["paypal-transmission-time"] as string | undefined;
  const transmissionSig = request.headers["paypal-transmission-sig"] as string | undefined;
  const certUrl = request.headers["paypal-cert-url"] as string | undefined;
  const authAlgo = request.headers["paypal-auth-algo"] as string | undefined;

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    reply.status(401).send({ error: { code: "MISSING_SIGNATURE", message: "Missing PayPal signature headers" } });
    return;
  }

  try {
    const valid = await verifyPaypalWebhookSignature(
      { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo },
      body,
    );
    if (!valid) {
      reply.status(401).send({ error: { code: "INVALID_SIGNATURE", message: "Invalid PayPal signature" } });
      return;
    }
  } catch (err) {
    request.server.log.error(err, "PayPal signature verification error");
    reply.status(401).send({ error: { code: "SIGNATURE_VERIFICATION_FAILED", message: "Could not verify signature" } });
    return;
  }

  const PAYPAL_HANDLED = new Set([
    "PAYMENT.CAPTURE.COMPLETED",
    "PAYMENT.CAPTURE.DENIED",
    "PAYMENT.CAPTURE.DECLINED",
    "CHECKOUT.ORDER.DECLINED",
  ]);

  if (!PAYPAL_HANDLED.has(body?.event_type ?? "")) {
    reply.status(200).send({ ok: true });
    return;
  }

  const isFailed = body?.event_type !== "PAYMENT.CAPTURE.COMPLETED";

  const ppOrderId = body.resource?.id;
  const referenceId = body.resource?.purchase_units?.[0]?.reference_id;
  const amountValue = body.resource?.purchase_units?.[0]?.amount?.value;
  const currency = body.resource?.purchase_units?.[0]?.amount?.currency_code ?? "USD";

  if (!referenceId) {
    reply.status(200).send({ ok: true });
    return;
  }

  try {
    const order = await request.server.drizzle.query.orders.findFirst({
      where: eq(orders.id, referenceId),
      columns: { id: true, userId: true, totalCents: true, currency: true },
    });

    if (!order) {
      reply.status(200).send({ ok: true });
      return;
    }

    await logPayment(request.server, {
      userId: order.userId,
      orderId: order.id,
      gateway: "paypal",
      externalId: ppOrderId ?? referenceId,
      status: isFailed ? "rejected" : "approved",
      amountCents: Math.round(parseFloat(amountValue ?? "0") * 100),
      currency,
      rawWebhook: body,
    });

    if (isFailed) {
      await failOrder(request.server, order.id);
    } else {
      await grantClassCredits(request.server, order.id);
    }
  } catch (err) {
    request.server.log.error(err, "PayPal webhook processing error");
  }

  reply.status(200).send({ ok: true });
}
