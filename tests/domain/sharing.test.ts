import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { hashToken, isWellFormedToken, linkStatus, newShareLink, normaliseEmail, sameHash, validateEmails, validateExpiresAt } from "../../src/domain/share-link.js";
import { DEFAULT_SHARING, LINK_TYPES, WHO_MAY_SHARE, mayMakeLink, sharingFromStored, validateSharing } from "../../src/domain/sharing.js";
import type { LinkType, SharingPolicy } from "../../src/domain/sharing.js";
import { readTenantCreated } from "../../src/domain/tenant.js";
import { randomShareTokens } from "../../src/adapters/system.js";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.field ?? ""}` : "other";
  }
  return undefined;
};
const now = new Date("2026-11-01T10:00:00.000Z");

describe("validateSharing", () => {
  it("takes the default when nothing is given and fills in what is left out", () => {
    expect(validateSharing(undefined)).toBe(DEFAULT_SHARING);
    expect(validateSharing({})).toEqual({ whoMayShare: "members", linkTypes: ["members"] });
    expect(validateSharing({ whoMayShare: "admins" })).toEqual({ whoMayShare: "admins", linkTypes: ["members"] });
  });

  it("keeps the link types once each in the canonical order", () => {
    expect(validateSharing({ linkTypes: ["everyone", "profiles", "members", "profiles"] }).linkTypes).toEqual(["members", "profiles", "everyone"]);
    expect(validateSharing({ linkTypes: [] }).linkTypes).toEqual([]);
  });

  it("refuses an unknown value, field or shape", () => {
    expect(codeOf(() => validateSharing("members"))).toBe("invalid_sharing:sharing");
    expect(codeOf(() => validateSharing(null))).toBe("invalid_sharing:sharing");
    expect(codeOf(() => validateSharing([]))).toBe("invalid_sharing:sharing");
    expect(codeOf(() => validateSharing({ whoMayShare: "all" }))).toBe("invalid_sharing:sharing.whoMayShare");
    expect(codeOf(() => validateSharing({ whoMayShare: null }))).toBe("invalid_sharing:sharing.whoMayShare");
    expect(codeOf(() => validateSharing({ linkTypes: ["members", 7] }))).toBe("invalid_sharing:sharing.linkTypes");
    expect(codeOf(() => validateSharing({ linkTypes: {} }))).toBe("invalid_sharing:sharing.linkTypes");
    expect(codeOf(() => validateSharing({ other: 1 }))).toBe("invalid_sharing:sharing.other");
  });

  it("reads a stored policy through the same checks", () => {
    expect(sharingFromStored("admins", ["everyone", "members"])).toEqual({ whoMayShare: "admins", linkTypes: ["members", "everyone"] });
    expect(codeOf(() => sharingFromStored("anyone", ["members"]))).toBe("invalid_sharing:sharing.whoMayShare");
  });
});

describe("mayMakeLink", () => {
  it("allows exactly the role and the type the policy names", () => {
    const expected = (who: SharingPolicy["whoMayShare"], role: "trader" | "tenant-admin", listed: boolean): boolean => who !== "none" && (who === "members" || role === "tenant-admin") && listed;
    for (const who of WHO_MAY_SHARE) {
      for (const role of ["trader", "tenant-admin"] as const) {
        for (const type of LINK_TYPES) {
          for (const types of [[], ["members"], ["profiles", "everyone"], [...LINK_TYPES]] as LinkType[][]) {
            const policy: SharingPolicy = { whoMayShare: who, linkTypes: types };
            expect(mayMakeLink(policy, role, type), `${who} ${role} ${type} [${types.join()}]`).toBe(expected(who, role, types.includes(type)));
          }
        }
      }
    }
  });
});

describe("share link rules", () => {
  it("makes a 43-character base64url token from 32 random bytes, a different one each time, and hashes it with SHA-256", () => {
    const a = randomShareTokens.newToken();
    const b = randomShareTokens.newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(isWellFormedToken(`${a}=`)).toBe(false);
    expect(isWellFormedToken(a.slice(1))).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });

  it("compares hashes in constant time and tells equal from different and from different lengths", () => {
    expect(sameHash(hashToken("a"), hashToken("a"))).toBe(true);
    expect(sameHash(hashToken("a"), hashToken("b"))).toBe(false);
    expect(sameHash("ab", "abc")).toBe(false);
  });

  it("validates the addresses: 1 to 50, valid, trimmed, lower case, once each", () => {
    expect(validateEmails([" Ana@Example.test", "ana@example.test", "b.c+tag@sub.example.test"])).toEqual(["ana@example.test", "b.c+tag@sub.example.test"]);
    expect(normaliseEmail("  A@B.Test ")).toBe("a@b.test");
    for (const bad of [[], "a@example.test", null, [1], [""], ["a"], ["a@b"], ["a b@example.test"], ["a@@example.test"], ["<a@example.test>"], ["a@-example.test"], [`${"x".repeat(65)}@example.test`], [`a@${"x".repeat(250)}.test`]]) {
      expect(codeOf(() => validateEmails(bad)), JSON.stringify(bad)).toMatch(/^invalid_share_link:emails/);
    }
    expect(validateEmails(Array.from({ length: 50 }, (_, i) => `u${i}@example.test`))).toHaveLength(50);
    expect(codeOf(() => validateEmails(Array.from({ length: 51 }, (_, i) => `u${i}@example.test`)))).toBe("invalid_share_link:emails");
  });

  it("wants an expiry in the future, as an RFC 3339 date-time with a zone", () => {
    expect(validateExpiresAt("2026-11-01T11:00:00Z", now).toISOString()).toBe("2026-11-01T11:00:00.000Z");
    for (const bad of ["2026-11-01T10:00:00Z", "2026-10-31T10:00:00Z", "tomorrow", "2026-02-30T10:00:00Z", 5, null]) {
      expect(codeOf(() => validateExpiresAt(bad, now)), String(bad)).toBe("invalid_share_link:expiresAt");
    }
  });

  it("reads the status: revoked wins over expired", () => {
    const later = new Date(now.getTime() + 1000);
    expect(linkStatus({ expiresAt: null, revokedAt: null }, now)).toBe("active");
    expect(linkStatus({ expiresAt: later, revokedAt: null }, now)).toBe("active");
    expect(linkStatus({ expiresAt: now, revokedAt: null }, now)).toBe("expired");
    expect(linkStatus({ expiresAt: now, revokedAt: now }, later)).toBe("revoked");
  });

  it("makes a link whose addresses belong to the type profiles alone", () => {
    const base = { id: "i", tokenHash: hashToken("t"), tenantId: "t", marketId: "m", createdBy: "u", now };
    expect(newShareLink({ ...base, type: "everyone" })).toMatchObject({ emails: [], expiresAt: null, revokedAt: null, type: "everyone" });
    expect(newShareLink({ ...base, type: "profiles", emails: ["A@example.test"] }).emails).toEqual(["a@example.test"]);
    expect(codeOf(() => newShareLink({ ...base, type: "profiles" }))).toBe("invalid_share_link:emails");
    expect(codeOf(() => newShareLink({ ...base, type: "members", emails: ["a@example.test"] }))).toBe("invalid_share_link:emails");
  });
});

describe("TenantCreated display name", () => {
  const event = (data: unknown) => ({
    specversion: "1.0",
    id: "018f3c1e-7a00-7000-8000-0000000000f1",
    type: "si.chance.tenants.TenantCreated.v1",
    tenantid: "018f3c1e-7a00-7000-8000-0000000000aa",
    data,
  });

  it("keeps a trimmed name and leaves it out when it is missing, empty, too long or odd", () => {
    expect(readTenantCreated(event({ name: "  Acme Bets " }))).toMatchObject({ kind: "tenant_created", notice: { name: "Acme Bets" } });
    for (const data of [{}, { name: "" }, { name: "   " }, { name: 7 }, { name: "x".repeat(201) }, { name: "bad\u0000name" }, undefined]) {
      const read = readTenantCreated(event(data));
      expect(read.kind).toBe("tenant_created");
      expect(read.kind === "tenant_created" && "name" in read.notice).toBe(false);
    }
  });
});
