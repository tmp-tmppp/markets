import { describe, expect, it } from "vitest";
import { AUTO_CLOSE_ACTOR, beginOpening, closeMarket, completeOpening, isDueForClose, newMarket, resolveMarket } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { TENANT_A } from "../support/fakes.js";

const RULES = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 60_000 };
const CREATED = new Date("2026-11-01T10:00:00.000Z");
const CLOSE_TIME = new Date("2026-11-02T10:00:00.000Z");

const draft: Market = newMarket(
  { id: "018f3c1e-7a00-7000-8000-000000000011", tenantId: TENANT_A, question: "Will the new bridge open before 2027?", closeTime: CLOSE_TIME.toISOString(), startingPrice: 0.4, fundingAmount: 500, createdBy: "admin-1", now: CREATED },
  RULES,
);
const opening = beginOpening(draft, CREATED);
const open = completeOpening(opening, CREATED);
const at = (offsetMs: number): Date => new Date(CLOSE_TIME.getTime() + offsetMs);

describe("AUTO_CLOSE_ACTOR", () => {
  it("is the documented fixed value, which no identity provider subject can be mistaken for", () => {
    expect(AUTO_CLOSE_ACTOR).toBe("system:auto-close");
  });

  it("is what an automatic close writes as closedBy through the ordinary transition", () => {
    const closed = closeMarket(open, AUTO_CLOSE_ACTOR, at(5));

    expect(closed).toMatchObject({ status: "closed", version: open.version + 1, closedBy: "system:auto-close", closedAt: at(5), closeTime: CLOSE_TIME });
  });
});

describe("isDueForClose", () => {
  it("is true for an open market at its close time and after it, false before", () => {
    expect(isDueForClose(open, at(-1))).toBe(false);
    expect(isDueForClose(open, at(0))).toBe(true);
    expect(isDueForClose(open, at(1))).toBe(true);
    expect(isDueForClose(open, at(30 * 86_400_000))).toBe(true);
  });

  it("is false for every other status, however late it is", () => {
    const closed = closeMarket(open, "admin-2", at(5));
    const resolved = resolveMarket(closed, "YES", "admin-2", at(6));
    for (const market of [draft, opening, closed, resolved]) expect(isDueForClose(market, at(86_400_000))).toBe(false);
  });
});
