import { FastifyRequest, FastifyReply } from "fastify";
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from "./auth.schemas";
import {
  registerUser,
  loginUser,
  refreshTokens_service,
  logoutUser,
  requestPasswordReset,
  resetPassword,
} from "./auth.service";
import { AppError } from "../../lib/errors";
import { env } from "../../config/env";

const REFRESH_COOKIE = "refresh_token";

const cookieOpts = {
  httpOnly: true,
  secure: env.cookie.secure,
  sameSite: "strict" as const,
  path: "/auth/refresh",
  domain: env.cookie.domain,
};

export async function registerController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message },
    });
    return;
  }

  const { accessToken, refreshToken } = await registerUser(request.server, parsed.data);

  reply
    .setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
    .status(201)
    .send({ data: { accessToken } });
}

export async function loginController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message },
    });
    return;
  }

  const { accessToken, refreshToken } = await loginUser(request.server, parsed.data, {
    userAgent: request.headers["user-agent"],
    ipAddress: request.ip,
  });

  reply
    .setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
    .status(200)
    .send({ data: { accessToken } });
}

export async function refreshController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawToken = request.cookies[REFRESH_COOKIE];
  if (!rawToken) {
    reply.status(401).send({ error: { code: "MISSING_REFRESH_TOKEN", message: "Refresh token required" } });
    return;
  }

  const { accessToken, refreshToken } = await refreshTokens_service(
    request.server,
    rawToken,
    { userAgent: request.headers["user-agent"], ipAddress: request.ip },
  );

  reply
    .setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
    .status(200)
    .send({ data: { accessToken } });
}

export async function logoutController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawToken = request.cookies[REFRESH_COOKIE];
  if (rawToken) {
    await logoutUser(request.server, rawToken);
  }
  reply.clearCookie(REFRESH_COOKIE, { path: "/auth/refresh" }).status(204).send();
}

export async function forgotPasswordController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = forgotPasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message },
    });
    return;
  }

  await requestPasswordReset(request.server, parsed.data.email);
  // Always 202 regardless of whether the email exists — see requestPasswordReset's
  // doc comment on why the response can't reveal that.
  reply.status(202).send({ data: { message: "If that email is registered, a reset link was sent" } });
}

export async function resetPasswordController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = resetPasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message },
    });
    return;
  }

  await resetPassword(request.server, parsed.data.token, parsed.data.password);
  reply.status(200).send({ data: { message: "Password updated" } });
}

export async function meController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const account = await request.server.drizzle.query.accounts.findFirst({
    where: (a, { eq }) => eq(a.id, request.user.sub),
    columns: { displayName: true, email: true },
  });
  reply.status(200).send({
    data: {
      userId: request.user.sub,
      role: request.user.role,
      displayName: account?.displayName ?? null,
      email: account?.email ?? null,
    },
  });
}
