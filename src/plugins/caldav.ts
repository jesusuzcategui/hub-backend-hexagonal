import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

interface CalDavClient {
  createEvent(uid: string, ical: string): Promise<void>;
  deleteEvent(uid: string): Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    caldav: CalDavClient;
  }
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function eventUrl(uid: string): string {
  const base = env.caldav.url.endsWith("/") ? env.caldav.url : `${env.caldav.url}/`;
  return `${base}${uid}.ics`;
}

async function caldavPlugin(fastify: FastifyInstance): Promise<void> {
  const auth = basicAuth(env.caldav.username, env.caldav.password);

  const client: CalDavClient = {
    async createEvent(uid, ical) {
      const res = await fetch(eventUrl(uid), {
        method: "PUT",
        headers: {
          Authorization: auth,
          "Content-Type": "text/calendar; charset=utf-8",
          "If-None-Match": "*", // fail if event already exists with this UID
        },
        body: ical,
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        throw new Error(`CalDAV PUT failed: ${res.status} ${res.statusText}`);
      }
    },

    async deleteEvent(uid) {
      const res = await fetch(eventUrl(uid), {
        method: "DELETE",
        headers: { Authorization: auth },
      });
      // 404 means already gone — treat as success
      if (!res.ok && res.status !== 404 && res.status !== 204) {
        throw new Error(`CalDAV DELETE failed: ${res.status} ${res.statusText}`);
      }
    },
  };

  fastify.decorate("caldav", client);
}

export default fp(caldavPlugin, { name: "caldav" });
