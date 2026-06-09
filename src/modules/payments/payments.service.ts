import { desc, eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { payments } from "../../db/schema";

export async function listUserPayments(fastify: FastifyInstance, userId: string) {
  return fastify.drizzle.query.payments.findMany({
    where: eq(payments.userId, userId),
    columns: {
      id: true,
      orderId: true,
      paymentType: true,
      status: true,
      amountCents: true,
      currency: true,
      mpPaymentId: true,
      processedAt: true,
      createdAt: true,
    },
    orderBy: (p, { desc: d }) => [d(p.createdAt)],
  });
}
