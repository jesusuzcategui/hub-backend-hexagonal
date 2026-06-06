import fp from "fastify-plugin";
import Redis from "ioredis";
import { FastifyInstance } from "fastify";
import { env } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

async function redisPlugin(fastify: FastifyInstance): Promise<void> {
  const redis = new Redis(env.cache.url);

  await redis.ping();
  fastify.log.info("Redis connected");

  fastify.decorate("redis", redis);
  fastify.addHook("onClose", async () => redis.quit());
}

export default fp(redisPlugin, { name: "redis" });
