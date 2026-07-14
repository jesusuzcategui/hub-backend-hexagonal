import { env } from "../../config/env.js";

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
    throw new Error("Captcha token required");
  }

  const response = await fetch("https://cap-captcha.vanjex.dev/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      privateKey: env.captcha.privateKey,
      clientToken: token,
    }),
  });

  const data = (await response.json()) as CapCaptchaVerifyResponse;

  if (!response.ok || !data.success) {
    throw new Error(`Captcha verification failed: ${data.error || "Unknown error"}`);
  }
}
