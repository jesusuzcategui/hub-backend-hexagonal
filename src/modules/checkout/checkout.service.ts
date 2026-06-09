import { eq, and } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { products, orders, orderItems, payments } from "../../db/schema";
import { classCredits } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { createMpPreference } from "./providers/mercadopago";
import { createPaypalOrder } from "./providers/paypal";
import { grantContentAccess } from "../content-access/content-access.service";
import type { CreateCheckoutInput } from "./checkout.schemas";

export async function createCheckout(
  fastify: FastifyInstance,
  userId: string,
  input: CreateCheckoutInput,
): Promise<{ orderId: string; paymentUrl: string; gateway: "mercadopago" | "paypal" }> {
  const db = fastify.drizzle;

  const product = await db.query.products.findFirst({
    where: and(eq(products.id, input.productId), eq(products.isActive, true)),
    columns: { id: true, name: true, priceCop: true, priceUsd: true, metadata: true },
  });

  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");

  const price = input.currency === "COP" ? product.priceCop : product.priceUsd * 100;

  const [order] = await db
    .insert(orders)
    .values({
      userId,
      subtotalCents: price,
      totalCents: price,
      currency: input.currency,
      metadata: { gateway: input.currency === "COP" ? "mercadopago" : "paypal" },
    })
    .returning({ id: orders.id });

  await db.insert(orderItems).values({
    orderId: order.id,
    productId: product.id,
    quantity: 1,
    unitPriceCents: price,
    totalCents: price,
    snapshot: { name: product.name, priceCop: product.priceCop, priceUsd: product.priceUsd },
  });

  if (input.currency === "COP") {
    const { preferenceId, initPoint } = await createMpPreference({
      orderId: order.id,
      productName: product.name,
      priceCop: product.priceCop,
    });

    await db.update(orders).set({
      gateway: "mercadopago",
      mpPreferenceId: preferenceId,
      mpExternalRef: order.id,
    }).where(eq(orders.id, order.id));

    return { orderId: order.id, paymentUrl: initPoint, gateway: "mercadopago" };
  } else {
    const { ppOrderId, approvalUrl } = await createPaypalOrder({
      orderId: order.id,
      productName: product.name,
      priceUsd: product.priceUsd,
    });

    await db.update(orders).set({
      gateway: "paypal",
      mpExternalRef: order.id,
      metadata: { ppOrderId },
    }).where(eq(orders.id, order.id));

    return { orderId: order.id, paymentUrl: approvalUrl, gateway: "paypal" };
  }
}

export async function listUserOrders(fastify: FastifyInstance, userId: string) {
  return fastify.drizzle.query.orders.findMany({
    where: eq(orders.userId, userId),
    columns: { id: true, status: true, gateway: true, totalCents: true, currency: true, paidAt: true, createdAt: true },
    orderBy: (o, { desc }) => [desc(o.createdAt)],
  });
}

export async function failOrder(fastify: FastifyInstance, orderId: string): Promise<void> {
  await fastify.drizzle
    .update(orders)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.status, "pending")));
}

export async function grantClassCredits(
  fastify: FastifyInstance,
  orderId: string,
): Promise<void> {
  const db = fastify.drizzle;

  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { id: true, userId: true, status: true },
  });

  if (!order || order.status === "paid") return;

  const [item] = await db.query.orderItems.findMany({
    where: eq(orderItems.orderId, orderId),
    columns: { productId: true },
    limit: 1,
  });

  if (!item) return;

  const product = await db.query.products.findFirst({
    where: eq(products.id, item.productId),
    columns: { id: true, metadata: true },
  });

  const credits = (product?.metadata as { credits?: number })?.credits ?? 0;
  if (credits <= 0) return;

  await db.transaction(async (tx) => {
    await tx.update(orders).set({ status: "paid", paidAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, orderId));

    await tx.insert(classCredits).values({
      userId: order.userId,
      orderId: order.id,
      productId: item.productId,
      totalCredits: credits,
    });
  });

  await grantContentAccess(fastify, {
    userId: order.userId,
    orderId: order.id,
    productId: item.productId,
  });
}

export async function logPayment(
  fastify: FastifyInstance,
  data: {
    userId: string;
    orderId: string;
    gateway: "mercadopago" | "paypal";
    externalId: string;
    status: "approved" | "rejected" | "pending";
    amountCents: number;
    currency: string;
    rawWebhook: unknown;
  },
): Promise<void> {
  const db = fastify.drizzle;

  const paymentStatus =
    data.status === "approved" ? "approved" :
    data.status === "rejected" ? "rejected" : "pending";

  await db.insert(payments).values({
    userId: data.userId,
    orderId: data.orderId,
    paymentType: "one_time",
    status: paymentStatus,
    amountCents: data.amountCents,
    currency: data.currency,
    mpPaymentId: data.externalId,
    mpRawWebhook: data.rawWebhook as Record<string, unknown>,
    processedAt: new Date(),
  });
}
