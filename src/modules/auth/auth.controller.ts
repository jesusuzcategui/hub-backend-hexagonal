import { FastifyRequest, FastifyReply } from "fastify";
import { registerSchema, loginSchema } from "./auth.schemas";
import {
  registerUser,
  loginUser,
  refreshTokens_service,
  logoutUser,
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

export async function meController(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.status(200).send({ data: { userId: request.user.sub, role: request.user.role } });
}
