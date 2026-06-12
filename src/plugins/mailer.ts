import fp from "fastify-plugin";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    mailer: Transporter;
  }
}

async function mailerPlugin(fastify: FastifyInstance) {
  const transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: {
      user: env.smtp.user,
      pass: env.smtp.pass,
    },
  });

  fastify.decorate("mailer", transporter);
  fastify.log.info("SMTP transporter ready");
}

export default fp(mailerPlugin, { name: "mailer" });
