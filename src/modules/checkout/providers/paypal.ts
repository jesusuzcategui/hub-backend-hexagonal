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
