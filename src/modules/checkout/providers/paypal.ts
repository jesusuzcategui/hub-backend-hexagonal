import { Client, Environment, OrdersController, CheckoutPaymentIntent, PaypalExperienceUserAction } from "@paypal/paypal-server-sdk";
import { env } from "../../../config/env";

const ppClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: env.paypal.clientId,
    oAuthClientSecret: env.paypal.clientSecret,
  },
  environment: env.paypal.mode === "live" ? Environment.Production : Environment.Sandbox,
});

const ordersController = new OrdersController(ppClient);

export interface PaypalOrderInput {
  orderId: string;
  productName: string;
  priceUsd: number;
}

export async function createPaypalOrder(input: PaypalOrderInput): Promise<{ ppOrderId: string; approvalUrl: string }> {
  const usdAmount = (input.priceUsd).toFixed(2);

  const result = await ordersController.createOrder({
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          referenceId: input.orderId,
          description: input.productName,
          amount: {
            currencyCode: "USD",
            value: usdAmount,
          },
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            returnUrl: env.paypal.successUrl,
            cancelUrl: env.paypal.cancelUrl,
            userAction: PaypalExperienceUserAction.PayNow,
          },
        },
      },
    },
  });

  const approvalUrl = result.result.links?.find((l) => l.rel === "payer-action")?.href;
  if (!approvalUrl) throw new Error("PayPal approval URL not found in response");

  return {
    ppOrderId: result.result.id!,
    approvalUrl,
  };
}

export async function capturePaypalOrder(ppOrderId: string): Promise<string> {
  const result = await ordersController.captureOrder({
    id: ppOrderId,
    body: {},
  });
  return result.result.status ?? "UNKNOWN";
}

export interface PaypalWebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

export async function verifyPaypalWebhookSignature(
  headers: PaypalWebhookHeaders,
  body: unknown,
): Promise<boolean> {
  if (!env.paypal.webhookId) {
    throw new Error("PAYPAL_WEBHOOK_ID is not configured — register a webhook in PayPal developer portal");
  }

  const apiBase =
    env.paypal.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${env.paypal.clientId}:${env.paypal.clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const verifyRes = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: env.paypal.webhookId,
      webhook_event: body,
    }),
  });

  const result = (await verifyRes.json()) as { verification_status?: string };
  return result.verification_status === "SUCCESS";
}
