import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_A } from "../support/fakes.js";
import { asAdmin, asPlatformAdmin, asTrader, call, createHarness, draftMarket, expectContract, openedMarket, validMarket } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.app.close();
});

const SOME_ID = "018f3c1e-7a00-7000-8000-0000000000f1";

/** Every markets endpoint, with a body that is valid where one is needed. */
const endpoints = () =>
  [
    ["GET", "/v1/markets", "/v1/markets", undefined],
    ["GET", `/v1/markets/${SOME_ID}`, "/v1/markets/{id}", undefined],
    ["POST", "/v1/markets", "/v1/markets", validMarket(h)],
    ["POST", `/v1/markets/${SOME_ID}/open`, "/v1/markets/{id}/open", undefined],
    ["POST", `/v1/markets/${SOME_ID}/close`, "/v1/markets/{id}/close", undefined],
    ["POST", `/v1/markets/${SOME_ID}/resolve`, "/v1/markets/{id}/resolve", { outcome: "YES" }],
  ] as const;

describe("authentication (401)", () => {
  it("answers 401 without a token, with a malformed header and with a bad token, on every endpoint", async () => {
    for (const [method, url, path, body] of endpoints()) {
      const variants: Array<Record<string, string>> = [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer not.a.jwt" }];
      for (const headers of variants) {
        const answer = await call(h, method, url, { token: null, headers, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url}`).toBe(401);
        expect(answer.headers["content-type"]).toContain("application/problem+json");
        expect(answer.headers["www-authenticate"]).toContain("Bearer");
        expect(answer.body).toMatchObject({ status: 401, code: "unauthorized", type: "urn:chance:problem:unauthorized" });
        expectContract(path, method, answer);
      }
    }
  });

  it("answers 401 for a token with the wrong issuer, audience, signature or an expired one", async () => {
    const bad = [
      await h.keys.sign({ ...asAdmin(), issuer: "http://localhost:8081/realms/other" }),
      await h.keys.sign({ ...asAdmin(), audience: "someone-else" }),
      await h.keys.signWithOtherKey(asAdmin()),
      await h.keys.sign({ ...asAdmin(), expiresIn: -60 }),
    ];
    for (const token of bad) {
      const answer = await h.app.inject({ method: "GET", url: "/v1/markets", headers: { authorization: `Bearer ${token}` } });
      expect(answer.statusCode).toBe(401);
    }
  });

  it("answers 401 for a correctly signed token that has no exp claim (it would never expire)", async () => {
    const token = await h.keys.sign({ ...asAdmin(), noExpiry: true });
    const answer = await h.app.inject({ method: "GET", url: "/v1/markets", headers: { authorization: `Bearer ${token}` } });
    expect(answer.statusCode).toBe(401);
    expect(answer.headers["www-authenticate"]).toContain("Bearer");
    expect(answer.json()).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("answers 401 for an unsigned token", async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.`;
    const answer = await h.app.inject({ method: "GET", url: "/v1/markets", headers: { authorization: `Bearer ${unsigned}` } });
    expect(answer.statusCode).toBe(401);
  });

  it("answers 401 for a token that names more than one organization, and accepts both claim shapes of one", async () => {
    expect((await call(h, "GET", "/v1/markets", { token: { ...asAdmin(), organization: [TENANT_A, "other"] } })).status).toBe(401);
    expect((await call(h, "GET", "/v1/markets", { token: { ...asAdmin(), organization: { a: {}, b: {} } } })).status).toBe(401);
    const asObject = await call(h, "GET", "/v1/markets", { token: { ...asAdmin(), organization: { [TENANT_A]: { id: "1" } } } });
    expect(asObject.status).toBe(200);
    // Contract v2: the role is the organization's group, so an organization sent as plain text carries no group and no role.
    const asText = await call(h, "GET", "/v1/markets", { token: { ...asAdmin(), organization: TENANT_A } });
    expect(asText.status).toBe(403);
  });

  it("does not write the token into the logs", async () => {
    const token = await h.sign(asAdmin("log-admin"));
    await h.app.inject({ method: "GET", url: "/v1/markets", headers: { authorization: `Bearer ${token}` } });
    expect(h.logLines.join("")).not.toContain(token);
  });
});

describe("the identity provider's signing keys (503)", () => {
  it("answers 503 with Retry-After, not 401, when the keys cannot be fetched, and recovers when they can", async () => {
    h.failKeys(new Error("connect ECONNREFUSED"));
    try {
      const answer = await call(h, "GET", "/v1/markets");
      expect(answer.status).toBe(503);
      expect(answer.headers["retry-after"]).toBe("5");
      expect(answer.body).toMatchObject({ code: "identity_provider_unavailable", status: 503 });
      expectContract("/v1/markets", "GET", answer);
    } finally {
      h.failKeys(null);
    }
    expect((await call(h, "GET", "/v1/markets")).status).toBe(200);
  });

  it("tells a key problem from a token problem: a timeout or a broken key set is 503, a key that does not match is 401", async () => {
    try {
      for (const failure of [new errors.JWKSTimeout(), new errors.JWKSInvalid("the key set is not valid"), new TypeError("fetch failed")]) {
        h.failKeys(failure);
        expect((await call(h, "GET", "/v1/markets")).status, failure.name).toBe(503);
      }
      h.failKeys(new errors.JWKSNoMatchingKey());
      expect((await call(h, "GET", "/v1/markets")).status).toBe(401);
    } finally {
      h.failKeys(null);
    }
  });
});

describe("roles and tenants (403)", () => {
  it("answers 403 to a platform admin on every endpoint, also with a tenant and a tenant role in the token", async () => {
    const tokens = [asPlatformAdmin(), { sub: "p-2", roles: ["platform-admin", "tenant-admin"], organization: [TENANT_A] }];
    for (const token of tokens) {
      for (const [method, url, path, body] of endpoints()) {
        const answer = await call(h, method, url, { token, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url}`).toBe(403);
        expect(answer.body).toMatchObject({ status: 403, code: "forbidden", type: "urn:chance:problem:forbidden" });
        expectContract(path, method, answer);
      }
    }
  });

  it("answers 403 to a token without a tenant, with a tenant that is not a UUID, or without a market role", async () => {
    const tokens = [
      { sub: "u", roles: ["tenant-admin"] },
      { sub: "u", roles: ["trader"], organization: null },
      { sub: "u", roles: ["tenant-admin"], organization: ["acme"] },
      { sub: "u", roles: [], organization: [TENANT_A] },
      { sub: "u", roles: ["viewer", "something-else"], organization: [TENANT_A] },
    ];
    for (const token of tokens) {
      for (const [method, url, , body] of endpoints()) {
        const answer = await call(h, method, url, { token, ...(body === undefined ? {} : { body }) });
        expect(answer.status, `${method} ${url} ${JSON.stringify(token)}`).toBe(403);
      }
    }
  });

  it("answers 403 before it validates the query, the path or the body", async () => {
    expect((await call(h, "GET", "/v1/markets?limit=0&nonsense=1", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "GET", "/v1/markets/not-a-uuid", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "POST", "/v1/markets", { token: asTrader(), body: { nonsense: true } })).status).toBe(403);
    expect((await call(h, "POST", "/v1/markets/not-a-uuid/open", { token: asTrader() })).status).toBe(403);
    expect((await call(h, "POST", `/v1/markets/${SOME_ID}/resolve`, { token: asTrader(), body: { outcome: "MAYBE" } })).status).toBe(403);
  });

  it("lets a trader read and nothing else", async () => {
    const trader = asTrader();
    expect((await call(h, "GET", "/v1/markets", { token: trader })).status).toBe(200);
    for (const [method, url, path, body] of endpoints().filter(([method]) => method === "POST")) {
      const answer = await call(h, method, url, { token: trader, ...(body === undefined ? {} : { body }) });
      expect(answer.status, `${method} ${url}`).toBe(403);
      expectContract(path, method, answer);
    }
  });

  it("gives a token with both groups of the organization no tenant role at all (contract v2: exactly one)", async () => {
    const both = { sub: "both-1", roles: ["trader", "tenant-admin"], organization: [TENANT_A] };
    expect((await call(h, "POST", "/v1/markets", { token: both, body: validMarket(h) })).status).toBe(403);
    expect((await call(h, "GET", "/v1/markets?status=draft", { token: both })).status).toBe(403);
  });

  it("takes the tenant from the token and the role from the token's roles, never from the request", async () => {
    const draft = await draftMarket(h, asAdmin("owner-1"));
    // A header or query that names the tenant changes nothing: only the unknown query parameter is refused.
    const answer = await call(h, "GET", `/v1/markets/${draft["id"]}`, { token: asAdmin("owner-1"), headers: { "x-tenant-id": "018f3c1e-7a00-7000-8000-0000000000bb" } });
    expect(answer.status).toBe(200);
    expect(answer.body?.["tenantId"]).toBe(TENANT_A);
    expect((await call(h, "GET", "/v1/markets?tenantId=018f3c1e-7a00-7000-8000-0000000000bb")).status).toBe(400);
    expect((await call(h, "POST", "/v1/markets", { body: validMarket(h, { tenantId: "018f3c1e-7a00-7000-8000-0000000000bb" }) })).status).toBe(400);
  });

  it("shows a trader the open market that an admin of the same tenant opened", async () => {
    const open = await openedMarket(h, asAdmin("owner-2"));
    const answer = await call(h, "GET", `/v1/markets/${open["id"]}`, { token: asTrader("t-9") });
    expect(answer.status).toBe(200);
    expectContract("/v1/markets/{id}", "GET", answer);
  });
});
