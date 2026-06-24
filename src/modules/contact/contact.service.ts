import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import type { ContactBody } from "./contact.schemas.js";

const BUDGET_LABELS: Record<string, string> = {
  "500-2k": "$500 – $2k",
  "2k-5k": "$2k – $5k",
  "5k-10k": "$5k – $10k",
  "10k-25k": "$10k – $25k",
  "25k+": "$25k+",
};

const TYPE_LABELS: Record<string, string> = {
  "e-commerce": "E-commerce",
  "website": "Website",
  "web-app": "Web App",
  "consultancy": "Consultoría / Consultancy",
};

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendContactEmail(
  fastify: FastifyInstance,
  body: ContactBody
) {
  const { name, email, message, projectType, budget } = body;
  const typeLbl = TYPE_LABELS[projectType];
  const budgetLbl = BUDGET_LABELS[budget];

  await fastify.mailer.sendMail({
    from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
    to: "hola@jesusuzcategui.com",
    replyTo: `"${name}" <${email}>`,
    subject: `[Portafolio] Nuevo contacto — ${typeLbl}`,
    text: [
      "Nuevo mensaje desde el formulario de contacto.",
      "",
      `Nombre:            ${name}`,
      `Email:             ${email}`,
      `Tipo de proyecto:  ${typeLbl}`,
      `Presupuesto:       ${budgetLbl}`,
      "",
      "Mensaje:",
      message,
    ].join("\n"),
    html: `
<h2 style="margin:0 0 16px">Nuevo contacto desde el portafolio</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
  <tr><td style="padding:6px 16px 6px 0;color:#888">Nombre</td><td style="padding:6px 0">${esc(name)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;color:#888">Email</td><td style="padding:6px 0"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
  <tr><td style="padding:6px 16px 6px 0;color:#888">Tipo de proyecto</td><td style="padding:6px 0">${esc(typeLbl)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;color:#888">Presupuesto</td><td style="padding:6px 0">${esc(budgetLbl)}</td></tr>
</table>
<h3 style="margin:20px 0 8px">Mensaje</h3>
<p style="white-space:pre-wrap;font-size:14px;line-height:1.6">${esc(message)}</p>
    `.trim(),
  });
}
