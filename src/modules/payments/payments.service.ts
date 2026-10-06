import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import {
  SystemClock,
  RandomIdGenerator,
  createOrder,
  createPaymentAttempt,
  settlePayment,
  settleManualPayment,
  isLegalFulfillmentTransition,
  type SettlementResult,
  type Order,
  type WebhookHeaders,
} from "hexagonal-payments-core";
import { accounts, carts, coupons, products, passwordResetTokens, paymentMethodSettings } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";
import { grantCreditsToStudent } from "../admin/admin.service";
import { grantContentAccess } from "../content-access/content-access.service";
import { DrizzleOrderRepository } from "../../adapters/payments/drizzle-order-repository";
import { DrizzlePaymentAttemptRepository } from "../../adapters/payments/drizzle-payment-attempt-repository";
import { DrizzlePaymentEventStore } from "../../adapters/payments/drizzle-payment-event-store";
import { EpaycoProvider, EpaycoContrasteUnavailableError } from "../../adapters/payments/epayco-provider";
import { PaypalProvider } from "../../adapters/payments/paypal-provider";
import { ManualTransferProvider } from "../../adapters/payments/manual-transfer-provider";
import { getOrderKindRegistry, CLASS_CREDIT_PLAN_KIND, CLASS_CREDIT_PLAN_VERSION } from "./kind-registry";
import { epaycoStatusMapper, paypalStatusMapper, manualTransferStatusMapper } from "./provider-status-mappers";
import { renderEmailHtml, BRAND_COLOR } from "../../lib/email-template";
import { contrasteMatchesOrder, studentFacingFulfillment, parseVerifySchedule } from "./review-verification";
import { flagOrderForReview, recordReviewEvent } from "./review-store";

export type PaymentMethod = "epayco" | "paypal" | "manual_transfer";

const clock = new SystemClock();

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const idGenerator = new RandomIdGenerator();

function buildRepos(fastify: FastifyInstance, insertContext?: { userId: string; cartId?: string | null }) {
  const orderRepository = new DrizzleOrderRepository(fastify.drizzle, insertContext);
  const paymentAttemptRepository = new DrizzlePaymentAttemptRepository(fastify.drizzle);
  const paymentEventStore = new DrizzlePaymentEventStore(fastify.drizzle);
  return { orderRepository, paymentAttemptRepository, paymentEventStore };
}

function buildProvider(method: PaymentMethod, paymentAttemptRepository: DrizzlePaymentAttemptRepository) {
  switch (method) {
    case "epayco":
      return new EpaycoProvider(paymentAttemptRepository);
    case "paypal":
      return new PaypalProvider(paymentAttemptRepository);
    case "manual_transfer":
      return new ManualTransferProvider();
  }
}

function statusMapperFor(method: PaymentMethod) {
  switch (method) {
    case "epayco":
      return epaycoStatusMapper;
    case "paypal":
      return paypalStatusMapper;
    case "manual_transfer":
      return manualTransferStatusMapper;
  }
}

// --- Account (find-or-create by email) ------------------------------------------
//
// ARCHITECTURAL DECISION: checkout is public/no-auth (buyers have no account yet at
// cart stage, same as the cart module). When the order needs a `userId` (payments.orders
// is NOT NULL on it — see src/db/schema/payments.ts), we find-or-create an account by
// the cart's buyerEmail. A newly created account gets `emailVerified: false` and no
// `passwordHash` — the same shape a magic-link/passwordless account would have. This is
// a deliberate choice: it lets a buyer who never registers still own their order/credits
// under their email, and a later "set your password" or magic-link flow (out of scope
// here) can claim the account. It does NOT issue any session/token — checkout does not
// log the buyer in.
async function findOrCreateAccountByEmail(
  fastify: FastifyInstance,
  email: string,
  displayName: string,
): Promise<{ id: string }> {
  const normalized = email.toLowerCase().trim();
  const db = fastify.drizzle;

  const existing = await db.query.accounts.findFirst({
    where: eq(accounts.email, normalized),
    columns: { id: true },
  });
  if (existing) return existing;

  const [created] = await db
    .insert(accounts)
    .values({
      email: normalized,
      displayName: displayName.trim() || normalized,
      passwordHash: null,
      emailVerified: false,
      role: "user",
      isActive: true,
    })
    .returning({ id: accounts.id });

  return created;
}

// --- Coupon validation ------------------------------------------------------------

async function validateAndPriceCoupon(
  fastify: FastifyInstance,
  code: string,
  amountMinor: number,
  currency: string,
): Promise<{ id: string; discountMinor: number } | null> {
  const normalized = code.toUpperCase().trim();
  const coupon = await fastify.drizzle.query.coupons.findFirst({
    where: eq(coupons.code, normalized),
  });

  if (!coupon) throw new AppError(404, "COUPON_NOT_FOUND", "Coupon not found");
  if (!coupon.isActive) throw new AppError(409, "COUPON_INACTIVE", "Coupon is not active");
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
    throw new AppError(409, "COUPON_EXPIRED", "Coupon has expired");
  }
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    throw new AppError(409, "COUPON_EXHAUSTED", "Coupon has no redemptions left");
  }
  if (coupon.type === "fixed" && coupon.currency && coupon.currency !== currency) {
    throw new AppError(409, "COUPON_CURRENCY_MISMATCH", "Coupon currency does not match cart currency");
  }

  const discountMinor =
    coupon.type === "percent"
      ? Math.round((amountMinor * coupon.value) / 100)
      : Math.min(coupon.value, amountMinor);

  return { id: coupon.id, discountMinor };
}

// --- Cart pricing -------------------------------------------------------------------
//
// A product's class-credit count is carried in `products.metadata.creditsCount` —
// same key every other reader in this file (applySettlementSideEffects,
// getOrderDetailForAdmin, listOrdersForStudent) already expects. Total
// credits granted = sum(creditsCount * qty) across cart items.
async function priceCartItems(
  fastify: FastifyInstance,
  items: Array<{ planId: string; qty: number; customAmountMinor?: number; customLabel?: string }>,
  currency: string,
): Promise<{ amountMinor: number; creditsCount: number; primaryProductId: string | null }> {
  if (items.length === 0) throw new AppError(400, "EMPTY_CART", "Cart has no items");

  const realIds = items.filter((i) => !i.customAmountMinor).map((i) => i.planId);
  const rows = realIds.length
    ? await fastify.drizzle
        .select({ id: products.id, priceCop: products.priceCop, priceUsd: products.priceUsd, metadata: products.metadata, isActive: products.isActive })
        .from(products)
        .where(inArray(products.id, realIds))
    : [];

  const byId = new Map(rows.map((r) => [r.id, r]));

  let amountMinor = 0;
  let creditsCount = 0;
  let primaryProductId: string | null = null;
  for (const item of items) {
    // Custom item: an ad-hoc charge, not a real product — no credits, no
    // product lookup, just the amount the admin set when generating the link.
    if (item.customAmountMinor) {
      amountMinor += item.customAmountMinor * item.qty;
      continue;
    }
    const product = byId.get(item.planId);
    if (!product || !product.isActive) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${item.planId} not found or inactive`);
    }
    const unitPrice = currency === "USD" ? product.priceUsd : product.priceCop;
    amountMinor += unitPrice * item.qty;
    const meta = product.metadata as Record<string, unknown> | null;
    const perUnitCredits = typeof meta?.creditsCount === "number" ? meta.creditsCount : 1;
    creditsCount += perUnitCredits * item.qty;
    primaryProductId ??= item.planId;
  }

  return { amountMinor, creditsCount, primaryProductId };
}

// --- Checkout -----------------------------------------------------------------------

export interface CheckoutInput {
  cartToken: string;
  paymentMethod: PaymentMethod;
  couponCode?: string;
}

export interface CheckoutResultDto {
  paymentMethod: PaymentMethod;
  redirectUrl?: string;
  /** ePayco's Smart Checkout has no redirect step — this is the sessionId the
   * frontend passes to ePayco's checkout.js widget instead. Absent for
   * providers that do redirect (PayPal). */
  providerRef?: string;
  status?: "awaiting_verification";
  orderId: string;
  attemptId: string;
}

export async function checkout(fastify: FastifyInstance, input: CheckoutInput): Promise<CheckoutResultDto> {
  const db = fastify.drizzle;

  const cart = await db.query.carts.findFirst({ where: eq(carts.id, input.cartToken) });
  if (!cart) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");
  if (cart.status !== "open") throw new AppError(409, "CART_NOT_OPEN", "Cart is not open");
  if (!cart.buyerEmail) throw new AppError(400, "MISSING_BUYER_EMAIL", "Cart has no buyer email");

  // Real gate, not just a hidden button on the storefront — an admin can
  // disable a method at runtime (a provider having a bad day) and this is
  // what actually stops a checkout call made directly against the API.
  const methodSetting = await db.query.paymentMethodSettings.findFirst({
    where: eq(paymentMethodSettings.method, input.paymentMethod),
  });
  if (methodSetting && !methodSetting.enabled) {
    throw new AppError(409, "PAYMENT_METHOD_DISABLED", "This payment method is temporarily unavailable");
  }

  const currency = (cart.currency ?? "COP").toUpperCase();
  const items = (cart.items as Array<{ planId: string; qty: number; customAmountMinor?: number; customLabel?: string }>) ?? [];

  const { amountMinor: subtotalMinor, creditsCount, primaryProductId } = await priceCartItems(
    fastify,
    items,
    currency,
  );

  let coupon: { id: string; discountMinor: number } | null = null;
  if (input.couponCode) {
    coupon = await validateAndPriceCoupon(fastify, input.couponCode, subtotalMinor, currency);
  }
  const amountMinor = Math.max(0, subtotalMinor - (coupon?.discountMinor ?? 0));

  const account = await findOrCreateAccountByEmail(
    fastify,
    cart.buyerEmail,
    cart.buyerName ?? cart.buyerEmail,
  );

  const { orderRepository, paymentAttemptRepository, paymentEventStore } = buildRepos(fastify, {
    userId: account.id,
    cartId: cart.id,
  });

  const order = await createOrder(
    {
      kind: CLASS_CREDIT_PLAN_KIND,
      kindVersion: CLASS_CREDIT_PLAN_VERSION,
      origin: "web",
      currency,
      amountMinor,
      metadata: {
        cartId: cart.id,
        productId: primaryProductId,
        creditsCount,
        locale: (cart.locale as "en" | "es") ?? "es",
        couponId: coupon?.id ?? null,
        couponCode: input.couponCode?.toUpperCase() ?? null,
        items,
      },
    },
    { kindRegistry: getOrderKindRegistry(), orderRepository, clock, idGenerator },
  );

  const attempt = await createPaymentAttempt(
    { orderId: order.id, provider: input.paymentMethod },
    { orderRepository, paymentAttemptRepository, clock, idGenerator },
  );

  const provider = buildProvider(input.paymentMethod, paymentAttemptRepository);
  const checkoutResult = await provider.createCheckout({
    orderId: order.id,
    reference: order.id,
    amountMinor,
    currency,
    // The thank-you page is a single URL shape (/order/:id) for every provider —
    // ePayco and PayPal don't know our internal order id, so we append it to their
    // configured base return URL ourselves. ePayco settles via webhook regardless
    // of this URL (purely cosmetic for it); PayPal needs the page to see its own
    // ?token= and call /paypal/capture before the order is actually paid.
    returnUrl:
      input.paymentMethod === "epayco"
        ? `${env.epayco.successUrl}/${order.id}`
        : input.paymentMethod === "paypal"
          ? `${env.paypal.successUrl}/${order.id}`
          : undefined,
    confirmationUrl: input.paymentMethod === "epayco" ? env.epayco.confirmationUrl : undefined,
    // Unlike returnUrl, PAYPAL_CANCEL_URL was a single static value with no
    // per-order locale — a buyer checking out in English who cancelled
    // still landed on the Spanish /pricing. Built here instead, from the
    // same portfolio origin + the cart's own locale, with a query param
    // /pricing reads to show a "sorry you cancelled" banner. Falls back to
    // the static env var only if PORTFOLIO_ORIGIN is unset.
    cancelUrl:
      input.paymentMethod === "paypal"
        ? env.mentoring.portfolioOrigin
          ? `${env.mentoring.portfolioOrigin}${cart.locale === "en" ? "/en" : ""}/pricing?payment=cancelled`
          : env.paypal.cancelUrl
        : undefined,
  });

  const attemptWithRef = attempt.withProviderRef(checkoutResult.providerRef);
  await paymentAttemptRepository.save(attemptWithRef);

  await db.update(carts).set({ status: "converted", updatedAt: new Date() }).where(eq(carts.id, cart.id));

  if (input.paymentMethod === "manual_transfer") {
    return { paymentMethod: input.paymentMethod, status: "awaiting_verification", orderId: order.id, attemptId: attempt.id };
  }

  return {
    paymentMethod: input.paymentMethod,
    redirectUrl: checkoutResult.redirectUrl,
    providerRef: checkoutResult.providerRef,
    orderId: order.id,
    attemptId: attempt.id,
  };
}

// --- Public order status (thank-you page) --------------------------------------------

export interface PublicOrderStatusDto {
  orderId: string;
  status: Order["status"];
  fulfillmentStatus: Order["fulfillmentStatus"];
  currency: string;
  amountMinor: number;
  paidAt: string | null;
  locale: "en" | "es";
  productName: string | null;
  creditsCount: number | null;
  paymentMethod: string | null;
  // null for a custom (product-less) order — "cuenta de cobro" charges have
  // nothing to fulfill and no student account to send the buyer to, unlike
  // a class-credit plan purchase. The thank-you page uses this to decide
  // whether to CTA "go to my account" or just confirm payment.
  productId: string | null;
}

/**
 * Public, no-auth: the frontend's thank-you page (`/order/:id`) polls this
 * instead of trusting a query-string status param — the order id (a uuid)
 * is unguessable, but deliberately returns no buyer PII (no email/name/
 * whatsapp/full metadata) since anyone with the link can hit this.
 */
export async function getPublicOrderStatus(
  fastify: FastifyInstance,
  orderId: string,
): Promise<PublicOrderStatusDto> {
  const orderRepo = new DrizzleOrderRepository(fastify.drizzle);
  const order = await orderRepo.findById(orderId);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

  const row = await orderRepo.findRowById(orderId);
  const metadata = (row?.metadata ?? null) as {
    productId?: string;
    creditsCount?: number;
    locale?: "en" | "es";
    items?: Array<{ customLabel?: string }>;
  } | null;
  const fulfillmentStatus = studentFacingFulfillment({
    fulfillmentStatus: order.fulfillmentStatus,
    reviewReason: row?.reviewReason,
  });

  let productName: string | null = null;
  if (metadata?.productId) {
    const product = await fastify.drizzle.query.products.findFirst({
      where: eq(products.id, metadata.productId),
      columns: { name: true },
    });
    productName = product?.name ?? null;
  } else {
    // Custom (product-less) order — the buyer-facing label the admin typed
    // when generating this checkout link.
    productName = metadata?.items?.[0]?.customLabel ?? null;
  }

  const { paymentAttemptRepository } = buildRepos(fastify);
  const latestAttempt = await paymentAttemptRepository.findLatestByOrderId(orderId);

  return {
    orderId: order.id,
    status: order.status,
    fulfillmentStatus,
    currency: order.currency,
    amountMinor: order.amountMinor,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    locale: metadata?.locale === "en" ? "en" : "es",
    productName,
    paymentMethod: latestAttempt?.provider ?? null,
    creditsCount: metadata?.creditsCount ?? null,
    productId: metadata?.productId ?? null,
  };
}

// --- PayPal capture trigger --------------------------------------------------------
//
// See PaypalProvider.captureOrder's doc comment: PayPal's Orders v2 API needs an
// explicit capture call after buyer approval — this is what the frontend calls when
// the browser returns from PayPal with `?token=<paypalOrderId>` in the URL. Actual
// settlement (credits, email, etc.) still happens via the normal webhook, not here.

export async function capturePaypalOrder(
  fastify: FastifyInstance,
  paypalOrderId: string,
): Promise<{ status: string; orderId: string | null }> {
  const { paymentAttemptRepository } = buildRepos(fastify);
  const provider = new PaypalProvider(paymentAttemptRepository);
  const attempt = await paymentAttemptRepository.findByProviderRef(paypalOrderId);
  try {
    const result = await provider.captureOrder(paypalOrderId);
    return { status: result.status, orderId: attempt?.orderId ?? null };
  } catch (err) {
    fastify.log.error({ err, paypalOrderId }, "PayPal capture failed");
    throw new AppError(502, "PAYPAL_CAPTURE_FAILED", "Failed to capture PayPal order");
  }
}

// --- Manual transfer proof upload ---------------------------------------------------

export async function attachManualTransferProof(
  fastify: FastifyInstance,
  attemptId: string,
  file: { filename: string; buffer: Buffer },
): Promise<void> {
  // file.filename is client-supplied (multipart) — sanitize before it becomes
  // part of a WebDAV path, or a name like "../../etc/passwd" lets a caller
  // write outside the intended manual-transfers directory.
  const safeName = path.basename(file.filename).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") {
    throw new AppError(400, "INVALID_FILENAME", "Invalid proof file name");
  }
  const remotePath = `/hub-payments/manual-transfers/${attemptId}-${safeName}`;

  // WebDAV PUT does not create missing parent directories (a plain PUT to a
  // path whose folder doesn't exist yet 404s on Nextcloud) — ensure the
  // target directory exists first. "already exists" is not an error here.
  const dir = "/hub-payments/manual-transfers";
  if (!(await fastify.webdav.exists(dir))) {
    await fastify.webdav.createDirectory(dir, { recursive: true });
  }

  await fastify.webdav.putFileContents(remotePath, file.buffer, { overwrite: true });

  const { paymentAttemptRepository } = buildRepos(fastify);
  const attempt = await paymentAttemptRepository.findById(attemptId);
  if (!attempt) throw new AppError(404, "ATTEMPT_NOT_FOUND", "Payment attempt not found");

  const updated = attempt.transitionTo("awaiting_verification").withProviderRef(remotePath);
  await paymentAttemptRepository.save(updated);
}

// --- Settlement side-effects (shared by webhook handlers + admin validate-transfer) --
//
// Factored into one function per the task's instruction: grant credits + email + Umami
// + coupon redemption must not be duplicated across the epayco webhook, paypal webhook,
// and admin validate-transfer endpoint.
/**
 * `forceNeedsReview`: ePayco's contraste was unavailable at webhook time. `contrasteRef` is the ePayco
 * reference (x_ref_payco) the automatic re-verification will ask ePayco about later.
 */
interface SettlementOptions {
  forceNeedsReview?: boolean;
  contrasteRef?: string;
}

async function applySettlementSideEffects(
  fastify: FastifyInstance,
  order: Order,
  options?: SettlementOptions,
): Promise<void> {
  const orderRepo = new DrizzleOrderRepository(fastify.drizzle);
  const row = await orderRepo.findRowById(order.id);
  if (!row) return;

  const metadata = row.metadata as {
    productId?: string;
    creditsCount?: number;
    locale?: "en" | "es";
    couponId?: string | null;
  } | null;

  const account = await fastify.drizzle.query.accounts.findFirst({
    where: eq(accounts.id, row.userId),
    columns: { id: true, email: true, displayName: true, passwordHash: true },
  });
  if (!account) return;

  // 1. Grant class credits (mirrors admin.service.ts's grantCreditsToStudent).
  // Tracks success of both grants so fulfillmentStatus can reflect reality
  // below — "delivered" only if both actually landed, "needs_review" if
  // either failed (a paid order whose fulfillment silently failed is
  // exactly the case fulfillmentStatus exists to surface).
  let creditsGranted = false;
  let contentAccessGranted = false;

  if (metadata?.productId && metadata.creditsCount) {
    try {
      await grantCreditsToStudent(fastify, account.id, {
        productId: metadata.productId,
        totalCredits: metadata.creditsCount,
        paymentMethod: row.status === "paid" ? "online" : "manual_transfer",
        grantedBy: account.id,
        notes: `Auto-granted on settlement of order ${order.id}`,
        orderId: order.id,
      });
      creditsGranted = true;
    } catch (err) {
      fastify.log.error({ err, orderId: order.id }, "Failed to grant class credits on settlement");
    }

    // 2. Content access (mirrors ecommerce order->content_access grant path).
    try {
      await grantContentAccess(fastify, { userId: account.id, orderId: order.id, productId: metadata.productId });
      contentAccessGranted = true;
    } catch (err) {
      fastify.log.error({ err, orderId: order.id }, "Failed to grant content access on settlement");
    }
  }

  // Reflect actual fulfillment outcome on the order (core's third,
  // independent state machine — see hexagonal-payments-core's
  // FulfillmentStatus). Left at "pending" if there was nothing to
  // fulfill (no productId/creditsCount in metadata) rather than lying
  // that delivery happened.
  if (metadata?.productId && metadata.creditsCount) {
    try {
      const target =
        !options?.forceNeedsReview && creditsGranted && contentAccessGranted
          ? "delivered"
          : "needs_review";
      const orderRepo = new DrizzleOrderRepository(fastify.drizzle);
      const fresh = await orderRepo.findById(order.id);
      if (fresh && isLegalFulfillmentTransition(fresh.fulfillmentStatus, target)) {
        await orderRepo.save(fresh.transitionFulfillment(target, clock.now()));
      }
      if (target === "needs_review") {
        // A failed grant is a REAL problem and wins over "contraste unavailable": it alerts admins right away
        // and the cron never touches it. When the grants landed and only ePayco's contraste was unavailable,
        // the student already has credits + the success email, so admins are only alerted if the automatic
        // re-verification later finds a mismatch or gives up (see review-verification.service.ts).
        const grantsFailed = !(creditsGranted && contentAccessGranted);
        const flagNow = clock.now();
        if (grantsFailed) {
          await flagOrderForReview(fastify.drizzle, { orderId: order.id, reason: "fulfillment_failed", now: flagNow, alerted: true });
          await notifyAdminsOfReviewNeeded(fastify, {
            orderId: order.id,
            buyerName: account.displayName,
            buyerEmail: account.email,
            amountMinor: order.amountMinor,
            currency: order.currency,
            reason: "El otorgamiento de créditos o acceso falló al momento de liquidar el pago.",
          });
        } else {
          await flagOrderForReview(fastify.drizzle, {
            orderId: order.id,
            reason: "contraste_unavailable",
            providerRef: options?.contrasteRef ?? null,
            now: flagNow,
            schedule: parseVerifySchedule(process.env),
          });
        }
      }
    } catch (err) {
      fastify.log.error({ err, orderId: order.id }, "Failed to update fulfillment status after settlement");
    }
  }

  // 3. Confirmation email, in the order's locale.
  try {
    const locale = metadata?.locale === "en" ? "en" : "es";
    const subject = locale === "en" ? "Payment confirmed" : "Pago confirmado";
    // account.displayName traces back to buyerName, a client-supplied field
    // at public checkout — escape before interpolating into HTML email.
    // order.id is a server-generated uuid, not user input, but escaping it
    // too costs nothing and removes any doubt.
    const safeName = escapeHtml(account.displayName);
    const safeOrderId = escapeHtml(order.id);

    // findOrCreateAccountByEmail creates a buyer's account with
    // passwordHash: null — there is no signup step, so without this link
    // a first-time buyer has no way in. Same token mechanism as
    // /auth/reset-password (single-use, 1h), it's just the first password
    // instead of a replacement one.
    // Custom (product-less) orders never get this — same reasoning as the
    // thank-you page's success copy: a "cuenta de cobro" payer isn't a
    // student and shouldn't be steered toward creating a Campus account.
    let setPasswordHtml = "";
    if (!account.passwordHash && metadata?.productId) {
      try {
        const raw = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(raw).digest("hex");
        await fastify.drizzle.insert(passwordResetTokens).values({
          userId: account.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const origin = (env.campus.origin ?? "https://campus.jesusuzcategui.com").replace(/\/+$/, "");
        const setPasswordUrl = escapeHtml(`${origin}/reset-password?token=${raw}`);
        const buttonLabel = locale === "en" ? "Set your password" : "Crear tu contraseña";
        const helper = locale === "en"
          ? "One more step: set a password to access your account and manage your bookings."
          : "Un paso más: creá tu contraseña para acceder a tu cuenta y gestionar tus clases.";
        setPasswordHtml = `
          <p>${helper}</p>
          <p style="margin:24px 0;"><a href="${setPasswordUrl}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">${buttonLabel}</a></p>
        `;
      } catch (err) {
        fastify.log.error({ err, orderId: order.id }, "Failed to create set-password link for settlement email");
      }
    }

    const body =
      locale === "en"
        ? `<p>Hi ${safeName},</p><p>Your payment for order <strong>${safeOrderId}</strong> has been confirmed. Your class credits are ready.</p>${setPasswordHtml}`
        : `<p>Hola ${safeName},</p><p>Tu pago para la orden <strong>${safeOrderId}</strong> ha sido confirmado. Tus créditos de clase ya están disponibles.</p>${setPasswordHtml}`;

    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: account.email,
      subject,
      html: renderEmailHtml({ title: subject, bodyHtml: body, locale }),
    });
  } catch (err) {
    fastify.log.error({ err, orderId: order.id }, "Failed to send settlement confirmation email");
  }

  // 4. Umami purchase event (server-side dispatch — no auth needed per Umami's own docs).
  // UNVERIFIED payload shape — see final report.
  if (env.umami.url && env.umami.websiteId) {
    try {
      await fetch(`${env.umami.url}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "event",
          payload: {
            website: env.umami.websiteId,
            name: "purchase",
            data: { orderId: order.id, amountMinor: order.amountMinor, currency: order.currency },
          },
        }),
      });
    } catch (err) {
      fastify.log.error({ err, orderId: order.id }, "Failed to dispatch Umami purchase event");
    }
  }

  // 5. Coupon redemption — only now, on confirmed settlement (never at checkout time,
  // to avoid burning a coupon on an abandoned/failed attempt).
  if (metadata?.couponId) {
    try {
      await fastify.drizzle
        .update(coupons)
        .set({ redeemedCount: sql`${coupons.redeemedCount} + 1`, updatedAt: new Date() })
        .where(eq(coupons.id, metadata.couponId));
    } catch (err) {
      fastify.log.error({ err, orderId: order.id }, "Failed to increment coupon redemption on settlement");
    }
  }
}

/**
 * Alerts admins the moment an order lands in needs_review — without this,
 * the only way to notice a stuck order was to stumble onto it in the orders
 * list. Mirrors schedule.service.ts's notifyAdminsOfBooking: fixed inbox
 * (env.campus.adminNotificationEmail) takes priority, falls back to every
 * active admin account.
 */
export async function notifyAdminsOfReviewNeeded(
  fastify: FastifyInstance,
  info: { orderId: string; buyerName: string; buyerEmail: string; amountMinor: number; currency: string; reason: string },
): Promise<void> {
  try {
    let recipients: string[];
    if (env.campus.adminNotificationEmail) {
      recipients = [env.campus.adminNotificationEmail];
    } else {
      const admins = await fastify.drizzle
        .select({ email: accounts.email })
        .from(accounts)
        .where(and(eq(accounts.role, "admin"), eq(accounts.isActive, true)));
      recipients = admins.map((a) => a.email);
    }
    if (recipients.length === 0) return;

    const currency = info.currency.toUpperCase();
    const amount = currency === "COP" ? info.amountMinor : info.amountMinor / 100;
    const safeName = escapeHtml(info.buyerName);
    const safeEmail = escapeHtml(info.buyerEmail);
    const safeReason = escapeHtml(info.reason);
    const origin = (env.campus.origin ?? "https://campus.jesusuzcategui.com").replace(/\/+$/, "");
    const ordersUrl = escapeHtml(`${origin}/admin/orders`);

    await fastify.mailer.sendMail({
      from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
      to: recipients.join(","),
      subject: `⚠️ Orden pendiente de revisión — ${safeName}`,
      html: renderEmailHtml({
        title: "Orden pendiente de revisión",
        bodyHtml: `
          <p>Una orden pagada quedó marcada como <strong>needs_review</strong> y necesita que la revises manualmente.</p>
          <p><strong>Comprador:</strong> ${safeName} (${safeEmail})</p>
          <p><strong>Monto:</strong> ${amount.toLocaleString("es-CO")} ${currency}</p>
          <p><strong>Motivo:</strong> ${safeReason}</p>
          <p><strong>Orden:</strong> ${escapeHtml(info.orderId)}</p>
          <p style="margin:24px 0;"><a href="${ordersUrl}" style="display:inline-block; background-color:${BRAND_COLOR}; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;">Ver en el panel</a></p>
        `,
      }),
    });
  } catch (err) {
    fastify.log.error({ err, orderId: info.orderId }, "Failed to send needs_review admin notification email");
  }
}

async function handleSettlementResult(
  fastify: FastifyInstance,
  result: SettlementResult,
  options?: SettlementOptions,
): Promise<void> {
  if (result.outcome === "applied" && result.order?.isPaid()) {
    await applySettlementSideEffects(fastify, result.order, options);
  }
  // "duplicate" / "rejected" outcomes: still respond 200 upstream (webhooks should not
  // be retry-stormed), but log for visibility.
  if (result.outcome !== "applied") {
    fastify.log.warn({ outcome: result.outcome, reason: result.reason }, "Payment settlement not applied");
  }
}

// --- Webhook handling -----------------------------------------------------------------

export async function handleEpaycoWebhook(
  fastify: FastifyInstance,
  rawBody: string | Buffer,
  headers: WebhookHeaders,
): Promise<SettlementResult> {
  const { orderRepository, paymentAttemptRepository, paymentEventStore } = buildRepos(fastify);
  const provider = new EpaycoProvider(paymentAttemptRepository);

  // Signature check happens inside settlePayment() BEFORE any repository work — but the
  // "contraste" server-to-server validation the spec requires is provider-specific and
  // must run between signature verification and trusting the event's own amount/currency,
  // so we do it here explicitly before calling settlePayment.
  if (!(await provider.verifyWebhookSignature(rawBody, headers))) {
    throw new AppError(401, "INVALID_WEBHOOK_SIGNATURE", "Invalid ePayco signature");
  }

  const parsed = await provider.parseWebhookEvent(rawBody, headers);
  if (!parsed.attemptId) {
    throw new AppError(404, "ATTEMPT_NOT_FOUND", "Webhook event did not resolve to a known payment attempt");
  }
  const { orderRepository: orderRepoForContraste } = buildRepos(fastify);
  const orderForContraste = await orderRepoForContraste.findByPaymentAttemptId(parsed.attemptId);
  if (!orderForContraste) {
    throw new AppError(404, "ORDER_NOT_FOUND", "No order found for this payment attempt");
  }

  // "Contraste": per spec, before trusting the webhook's own amount/currency,
  // confirm them server-to-server against ePayco's own validation endpoint.
  // A genuine MISMATCH fails closed (real fraud signal — reject). ePayco's
  // own endpoint being unavailable/erroring (confirmed to happen for real,
  // valid transactions — see EpaycoContrasteUnavailableError) fails SAFE
  // instead: still settle (the signature already proved authenticity), but
  // force the order into needs_review so an admin double-checks it by hand
  // against ePayco's dashboard rather than silently losing a real payment.
  let contrasteUnavailable = false;
  try {
    const contraste = await provider.validateTransactionByReference(parsed.providerEventId);
    // Invoice always has to match; amount/currency are only asserted when the webhook claims the payment was
    // actually accepted — forging a "rejected"/"pending" webhook with a mismatched amount moves no money and
    // grants nothing, so being strict there only breaks legitimate decline notifications (confirmed by a real
    // ePayco test transaction where that happened). Shared with the re-verification (review-verification.ts).
    const isApproved = parsed.status === "Aceptada";
    if (!contrasteMatchesOrder(contraste, orderForContraste, { isApproved })) {
      fastify.log.error(
        { contraste, orderId: orderForContraste.id, orderAmount: orderForContraste.amountMinor, orderCurrency: orderForContraste.currency, status: parsed.status },
        "ePayco contraste mismatch — refusing to settle",
      );
      throw new AppError(409, "CONTRASTE_MISMATCH", "ePayco server-side validation did not match the order");
    }
  } catch (err) {
    if (err instanceof EpaycoContrasteUnavailableError) {
      contrasteUnavailable = true;
      fastify.log.error(
        { err, orderId: orderForContraste.id },
        "ePayco contraste endpoint unavailable — settling anyway, flagged for manual review",
      );
    } else {
      throw err;
    }
  }

  const result = await settlePayment(
    { rawBody, headers, provider },
    { orderRepository, paymentAttemptRepository, paymentEventStore, clock, idGenerator, mapProviderStatus: epaycoStatusMapper },
  );
  await handleSettlementResult(fastify, result, {
    forceNeedsReview: contrasteUnavailable,
    contrasteRef: contrasteUnavailable ? parsed.providerEventId : undefined,
  });
  return result;
}

export async function handlePaypalWebhook(
  fastify: FastifyInstance,
  rawBody: string | Buffer,
  headers: WebhookHeaders,
): Promise<SettlementResult> {
  const { orderRepository, paymentAttemptRepository, paymentEventStore } = buildRepos(fastify);
  const provider = new PaypalProvider(paymentAttemptRepository);

  const result = await settlePayment(
    { rawBody, headers, provider },
    { orderRepository, paymentAttemptRepository, paymentEventStore, clock, idGenerator, mapProviderStatus: paypalStatusMapper },
  );
  await handleSettlementResult(fastify, result);
  return result;
}

// --- Payment methods (public read) --------------------------------------------------------

const ALL_PAYMENT_METHODS: PaymentMethod[] = ["epayco", "paypal", "manual_transfer"];

// Public, no-auth — the storefront needs this to know which buttons to show.
// Missing rows (shouldn't happen post-migration, but just in case) default
// to enabled, same as the checkout() guard's fail-open-if-unknown stance.
export async function listPaymentMethods(fastify: FastifyInstance): Promise<Record<PaymentMethod, boolean>> {
  const rows = await fastify.drizzle.query.paymentMethodSettings.findMany();
  const byMethod = new Map(rows.map((r) => [r.method, r.enabled]));
  return Object.fromEntries(
    ALL_PAYMENT_METHODS.map((m) => [m, byMethod.get(m) ?? true]),
  ) as Record<PaymentMethod, boolean>;
}

// --- Student: own order history ---------------------------------------------------------

export async function listOrdersForStudent(fastify: FastifyInstance, userId: string) {
  const { orders: ordersTable } = await import("../../db/schema");

  const rows = await fastify.drizzle
    .select({
      id: ordersTable.id,
      amountMinor: ordersTable.amountMinor,
      currency: ordersTable.currency,
      status: ordersTable.status,
      fulfillmentStatus: ordersTable.fulfillmentStatus,
      reviewReason: ordersTable.reviewReason,
      paidAt: ordersTable.paidAt,
      createdAt: ordersTable.createdAt,
      metadata: ordersTable.metadata,
    })
    .from(ordersTable)
    .where(eq(ordersTable.userId, userId))
    .orderBy(desc(ordersTable.createdAt))
    .limit(200);

  // metadata.productId isn't joinable in SQL (it's inside a jsonb blob), so
  // batch-resolve names in one extra query instead of one per row — a
  // student's own order count is small, but there's no reason to N+1 it.
  const productIds = [
    ...new Set(
      rows
        .map((r) => (r.metadata as { productId?: string } | null)?.productId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const productNames = productIds.length
    ? await fastify.drizzle
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(inArray(products.id, productIds))
    : [];
  const nameById = new Map(productNames.map((p) => [p.id, p.name]));

  return rows.map((r) => {
    const metadata = r.metadata as {
      productId?: string;
      creditsCount?: number;
      couponCode?: string | null;
      items?: Array<{ customLabel?: string }>;
    } | null;
    return {
      id: r.id,
      amountMinor: r.amountMinor,
      currency: r.currency,
      status: r.status,
      // Students never see "needs verification" when the only reason is ePayco's contraste being unavailable.
      fulfillmentStatus: studentFacingFulfillment({ fulfillmentStatus: r.fulfillmentStatus, reviewReason: r.reviewReason }),
      paidAt: r.paidAt,
      createdAt: r.createdAt,
      productName: (metadata?.productId ? nameById.get(metadata.productId) : undefined) ?? metadata?.items?.[0]?.customLabel ?? null,
      creditsCount: metadata?.creditsCount ?? null,
      couponCode: metadata?.couponCode ?? null,
    };
  });
}

// --- Admin: orders list + manual-transfer validation -----------------------------------

export async function listOrdersForAdmin(
  fastify: FastifyInstance,
  filters: { status?: string; fulfillmentStatus?: string },
) {
  const { orders: ordersTable } = await import("../../db/schema");
  const conditions = [];
  if (filters.status) conditions.push(eq(ordersTable.status, filters.status as never));
  if (filters.fulfillmentStatus) conditions.push(eq(ordersTable.fulfillmentStatus, filters.fulfillmentStatus as never));

  return fastify.drizzle
    .select()
    .from(ordersTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(ordersTable.createdAt))
    .limit(200);
}

export async function getOrderDetailForAdmin(fastify: FastifyInstance, orderId: string) {
  const { orders: ordersTable, paymentAttempts: attemptsTable } = await import("../../db/schema");

  const order = await fastify.drizzle.query.orders.findFirst({ where: eq(ordersTable.id, orderId) });
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

  const [buyer] = await fastify.drizzle
    .select({ id: accounts.id, email: accounts.email, displayName: accounts.displayName })
    .from(accounts)
    .where(eq(accounts.id, order.userId))
    .limit(1);

  const attempts = await fastify.drizzle
    .select({
      id: attemptsTable.id,
      provider: attemptsTable.provider,
      status: attemptsTable.status,
      providerRef: attemptsTable.providerRef,
      createdAt: attemptsTable.createdAt,
    })
    .from(attemptsTable)
    .where(eq(attemptsTable.orderId, orderId))
    .orderBy(desc(attemptsTable.createdAt));

  const metadata = (order.metadata ?? null) as {
    productId?: string;
    creditsCount?: number;
    locale?: string;
    couponId?: string | null;
    couponCode?: string | null;
    items?: Array<{ customLabel?: string }>;
  } | null;

  let productName: string | null = null;
  if (metadata?.productId) {
    const product = await fastify.drizzle.query.products.findFirst({
      where: eq(products.id, metadata.productId),
      columns: { name: true },
    });
    productName = product?.name ?? null;
  } else {
    productName = metadata?.items?.[0]?.customLabel ?? null;
  }

  const latestManualTransferAttempt = attempts.find((a) => a.provider === "manual_transfer");

  return {
    order,
    buyer: buyer ?? null,
    attempts,
    productName,
    creditsCount: metadata?.creditsCount ?? null,
    couponCode: metadata?.couponCode ?? null,
    hasManualTransferProof: Boolean(latestManualTransferAttempt?.providerRef),
  };
}

const PROOF_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

// The upload path (attachManualTransferProof) never captured the client's
// claimed mimetype, so it can't be trusted anyway — content type here is
// derived from the (already sanitized, alnum-only) file extension against a
// fixed allowlist. Anything outside it is forced to download rather than
// render inline, so this can never become a stored-XSS vector.
export async function getManualTransferProof(fastify: FastifyInstance, orderId: string) {
  const { paymentAttempts: attemptsTable } = await import("../../db/schema");

  const [attempt] = await fastify.drizzle
    .select({ providerRef: attemptsTable.providerRef, provider: attemptsTable.provider })
    .from(attemptsTable)
    .where(and(eq(attemptsTable.orderId, orderId), eq(attemptsTable.provider, "manual_transfer")))
    .orderBy(desc(attemptsTable.createdAt))
    .limit(1);

  if (!attempt?.providerRef) throw new AppError(404, "PROOF_NOT_FOUND", "No manual-transfer proof for this order");

  const remotePath = attempt.providerRef;
  const filename = remotePath.split("/").pop() ?? "proof";
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType = PROOF_CONTENT_TYPES[extension];

  const buffer = (await fastify.webdav.getFileContents(remotePath)) as Buffer;
  return {
    buffer,
    filename,
    contentType: contentType ?? "application/octet-stream",
    inline: Boolean(contentType),
  };
}

/**
 * Clears fulfillment_status: "needs_review" back to "delivered" for an
 * order whose payment is already confirmed (status: "paid") — used when an
 * admin manually double-checked a payment the automated path couldn't
 * verify on its own (e.g. ePayco's contraste/reconciliation endpoint was
 * unavailable, see handleEpaycoWebhook's forceNeedsReview). Credits and
 * content access were already granted at settlement time regardless of
 * this flag — this only clears the manual-review marker, it does not
 * re-run any grant.
 */
export async function resolveOrderReview(fastify: FastifyInstance, orderId: string): Promise<void> {
  const orderRepo = new DrizzleOrderRepository(fastify.drizzle);
  const order = await orderRepo.findById(orderId);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  if (order.status !== "paid") {
    throw new AppError(409, "ORDER_NOT_PAID", "Order is not paid yet");
  }
  if (order.fulfillmentStatus !== "needs_review") {
    throw new AppError(409, "NOT_NEEDS_REVIEW", "Order is not pending manual review");
  }

  await orderRepo.save(order.transitionFulfillment("delivered", clock.now()));
}

export async function validateManualTransfer(
  fastify: FastifyInstance,
  orderId: string,
  decision: "approve" | "reject",
): Promise<SettlementResult> {
  const { orderRepository, paymentAttemptRepository, paymentEventStore } = buildRepos(fastify);

  const order = await orderRepository.findById(orderId);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");

  const attempt = await paymentAttemptRepository.findById(
    (await fastify.drizzle.query.paymentAttempts.findFirst({
      where: (a, { eq: eqOp }) => eqOp(a.orderId, orderId),
      columns: { id: true },
      orderBy: (a, { desc: descOp }) => [descOp(a.createdAt)],
    }))?.id ?? "",
  );
  if (!attempt) throw new AppError(404, "ATTEMPT_NOT_FOUND", "No payment attempt found for this order");

  const provider = new ManualTransferProvider();
  const result = await settleManualPayment(
    {
      provider,
      attemptId: attempt.id,
      confirmationId: `admin-review:${Date.now()}`,
      status: decision === "approve" ? "paid" : "failed",
      amountMinor: order.amountMinor,
      currency: order.currency,
    },
    { orderRepository, paymentAttemptRepository, paymentEventStore, clock, idGenerator, mapProviderStatus: manualTransferStatusMapper },
  );

  await handleSettlementResult(fastify, result);
  return result;
}
