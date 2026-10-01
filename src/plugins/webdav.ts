import fp from "fastify-plugin";
import { createClient, type WebDAVClient } from "webdav";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    webdav: WebDAVClient;
  }
}

async function webdavPlugin(fastify: FastifyInstance) {
  const client = createClient(env.webdav.url, {
    username: env.webdav.username,
    password: env.webdav.password,
  });

  fastify.decorate("webdav", client);
  fastify.log.info("WebDAV client ready");
}

export default fp(webdavPlugin, { name: "webdav" });
