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

  const uri = `https://cap-captcha.vanjex.dev/${env.captcha.siteKey}/siteverify`;

  console.log("[Captcha] Verifying token:", uri);
  console.log("[Captcha] ", env.captcha.siteKey);
  console.log("[Captcha] ", env.captcha.privateKey);
  console.log("[Captcha] ", token);

  const response = await fetch(uri, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.captcha.privateKey,
      response: token,
    }),
  });

  const data = (await response.json()) as CapCaptchaVerifyResponse;
  console.log("[Captcha] API response:", { status: response.status, data });

  if (!response.ok || !data.success) {
    throw new Error(`Captcha verification failed: ${data.error || "Unknown error"}`);
  }
}
