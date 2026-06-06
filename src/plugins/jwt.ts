import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env";

export interface AccessTokenPayload extends JWTPayload {
  sub: string;
  role: "user" | "admin";
}

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken(payload: Omit<AccessTokenPayload, "iat" | "exp">): Promise<string>;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    user: AccessTokenPayload;
  }
}

const secret = new TextEncoder().encode(env.jwt.accessSecret);

async function jwtPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorate(
    "signAccessToken",
    async (payload: Omit<AccessTokenPayload, "iat" | "exp">): Promise<string> => {
      return new SignJWT(payload as JWTPayload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(`${env.jwt.accessExpirySeconds}s`)
        .sign(secret);
    },
  );

  fastify.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        reply.status(401).send({ error: { code: "MISSING_TOKEN", message: "Authentication required" } });
        return;
      }
      const token = authHeader.slice(7);
      try {
        const { payload } = await jwtVerify<AccessTokenPayload>(token, secret);
        request.user = payload;
      } catch {
        reply.status(401).send({ error: { code: "INVALID_TOKEN", message: "Token invalid or expired" } });
      }
    },
  );
}

export default fp(jwtPlugin, { name: "jwt" });
