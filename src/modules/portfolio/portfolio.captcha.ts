import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

export interface CapCaptchaVerifyResponse {
  success: boolean;
  error?: string;
}

export async function verifyCaptchaToken(token: string | undefined): Promise<void> {
  // Si no hay siteKey/privateKey configuradas, skip validation
  if (!env.captcha.siteKey || !env.captcha.privateKey) {
    return;
  }

  // Si no hay token pero captcha está habilitado, error
  if (!token) {
    throw new AppError(400, "CAPTCHA_REQUIRED", "Captcha token required");
  }

  const uri = `https://cap-captcha.vanjex.dev/${env.captcha.siteKey}/siteverify`;

  const response = await fetch(uri, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.captcha.privateKey,
      response: token,
    }),
  });

  const data = (await response.json()) as CapCaptchaVerifyResponse;
  if (!response.ok || !data.success) {
    throw new AppError(400, "CAPTCHA_FAILED", "Captcha verification failed");
  }
}
