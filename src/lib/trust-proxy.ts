/**
 * Parses TRUST_PROXY for Fastify's `trustProxy` option.
 *   unset / "" / "false" / "0"  -> false   (default: req.ip is the socket peer; nothing changes locally)
 *   "true"                      -> true    (trust every hop; only safe when the app is reachable solely via the proxy)
 *   "10.0.0.0/8, 172.16.0.0/12" -> list of addresses/CIDRs to trust (preferred: spoofing-safe)
 * Hop counts ("1", "2") are rejected on purpose: this Fastify version treats a numeric trustProxy as "trust nothing"
 * (it cannot validate the immediate peer), so accepting one would silently do nothing.
 * Behind a reverse proxy (Coolify/Traefik) without this, req.ip is the proxy's address and every rate-limit
 * counter collapses into one.
 */
export type TrustProxy = boolean | string[];

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? "").trim();
  if (v === "" || /^false$/i.test(v) || v === "0") return false;
  if (/^true$/i.test(v)) return true;
  if (/^\d+$/.test(v)) {
    throw new Error(`TRUST_PROXY hop counts are not supported (got "${v}"): use "true" or a comma-separated list of proxy addresses/CIDRs`);
  }
  const list = v.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length > 0 ? list : false;
}
