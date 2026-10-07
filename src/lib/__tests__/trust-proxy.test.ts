import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { parseTrustProxy } from "../trust-proxy";

describe("parseTrustProxy", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["true", true],
    ["True", true],
    ["10.0.0.0/8", ["10.0.0.0/8"]],
    ["10.0.0.0/8, 172.16.0.0/12 ,127.0.0.1", ["10.0.0.0/8", "172.16.0.0/12", "127.0.0.1"]],
  ])("%j -> %j", (input, expected) => {
    expect(parseTrustProxy(input as string | undefined)).toEqual(expected);
  });
});

describe("hop counts", () => {
  it.each(["1", "2", "10"])("%s is rejected: this Fastify treats numeric trustProxy as trust-nothing", (v) => {
    expect(() => parseTrustProxy(v)).toThrow(/hop counts are not supported/);
  });
});

async function ipSeenBehind(raw: string | undefined) {
  const app = Fastify({ trustProxy: parseTrustProxy(raw) });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  await app.ready();
  const res = await app.inject({
    method: "GET",
    url: "/ip",
    remoteAddress: "10.0.0.5", // the proxy
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  await app.close();
  return res.json().ip as string;
}

describe("X-Forwarded-For handling", () => {
  it("is ignored by default: req.ip is the proxy (every client shares one rate-limit bucket)", async () => {
    expect(await ipSeenBehind(undefined)).toBe("10.0.0.5");
    expect(await ipSeenBehind("false")).toBe("10.0.0.5");
  });

  it("is honored when TRUST_PROXY is enabled (true or the CIDR of the proxy)", async () => {
    expect(await ipSeenBehind("true")).toBe("203.0.113.9");
    expect(await ipSeenBehind("10.0.0.0/8")).toBe("203.0.113.9");
  });

  it("is NOT honored from a peer outside the trusted CIDRs", async () => {
    expect(await ipSeenBehind("192.168.0.0/16")).toBe("10.0.0.5");
  });
});
