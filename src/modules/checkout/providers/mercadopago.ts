import { MercadoPagoConfig, Preference } from "mercadopago";
import { env } from "../../../config/env";

const mpClient = new MercadoPagoConfig({ accessToken: env.mercadopago.accessToken });
const preferenceClient = new Preference(mpClient);

export interface MpPreferenceInput {
  orderId: string;
  productName: string;
  priceCop: number;
}

export async function createMpPreference(input: MpPreferenceInput): Promise<{ preferenceId: string; initPoint: string }> {
  const notificationUrl = env.app.publicUrl
    ? `${env.app.publicUrl}/webhooks/mercadopago`
    : undefined;

  const result = await preferenceClient.create({
    body: {
      items: [
        {
          id: input.orderId,
          title: input.productName,
          quantity: 1,
          unit_price: input.priceCop,
          currency_id: "COP",
        },
      ],
      back_urls: {
        success: env.mercadopago.successUrl,
        failure: env.mercadopago.failureUrl,
        pending: env.mercadopago.pendingUrl,
      },
      auto_return: "approved",
      external_reference: input.orderId,
      ...(notificationUrl && { notification_url: notificationUrl }),
    },
  });

  return {
    preferenceId: result.id!,
    initPoint: result.init_point!,
  };
}
