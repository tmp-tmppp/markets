import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import {
  MAX_CLOSE_AHEAD_MS,
  beginOpening,
  canTransition,
  closeMarket,
  completeOpening,
  isMarketStatus,
  isOutcome,
  newMarket,
  noStartingPrice,
  parseDateTime,
  parseOutcome,
  resolveMarket,
  revertOpening,
  validateCloseTime,
  validateDescription,
  validateFundingAmount,
  validateQuestion,
  validateStartingPrice,
} from "../../src/domain/market.js";
import type { Market, MarketStatus, Outcome } from "../../src/domain/market.js";

const now = new Date("2026-11-01T10:00:00.000Z");
const rules = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 5 * 60_000 };
const input = {
  id: "00000000-0000-7000-8000-000000000001",
  tenantId: "018f3c1e-7a00-7000-8000-0000000000aa",
  question: "  Will it rain in Ljubljana tomorrow?  ",
  closeTime: "2026-11-02T10:00:00Z",
  startingPrice: 0.35,
  fundingAmount: 1000,
  createdBy: "admin-1",
  now,
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
};

const fieldOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.field;
    throw error;
  }
  return undefined;
};

describe("newMarket", () => {
  it("creates a draft at version 1 with trimmed text and no lifecycle times", () => {
    const market = newMarket(input, rules);
    expect(market).toEqual({
      id: input.id,
      tenantId: input.tenantId,
      question: "Will it rain in Ljubljana tomorrow?",
      description: "",
      closeTime: new Date("2026-11-02T10:00:00.000Z"),
      startingPrice: 0.35,
      fundingAmount: 1000,
      status: "draft",
      outcome: null,
      version: 1,
      createdBy: "admin-1",
      createdAt: now,
      updatedAt: now,
      openedAt: null,
      closedAt: null,
      closedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      sharing: { whoMayShare: "members", linkTypes: ["members"] },
    } satisfies Market);
  });

  it("names the first invalid field", () => {
    expect(fieldOf(() => newMarket({ ...input, question: "short" }, rules))).toBe("question");
    expect(fieldOf(() => newMarket({ ...input, description: "x".repeat(2001) }, rules))).toBe("description");
    expect(fieldOf(() => newMarket({ ...input, closeTime: "tomorrow" }, rules))).toBe("closeTime");
    expect(fieldOf(() => newMarket({ ...input, startingPrice: 1 }, rules))).toBe("startingPrice");
    expect(fieldOf(() => newMarket({ ...input, fundingAmount: 99 }, rules))).toBe("fundingAmount");
  });
});

describe("validateQuestion", () => {
  it("accepts 10 to 200 characters counted as code points", () => {
    expect(validateQuestion("a".repeat(10))).toHaveLength(10);
    expect(validateQuestion("a".repeat(200))).toHaveLength(200);
    // Ten emoji are ten characters for the database's char_length, twenty UTF-16 units for JavaScript.
    expect(validateQuestion("\u{1F600}".repeat(10))).toBe("\u{1F600}".repeat(10));
    expect(codeOf(() => validateQuestion("\u{1F600}".repeat(5)))).toBe("invalid_question");
    expect(codeOf(() => validateQuestion("a".repeat(9)))).toBe("invalid_question");
    expect(codeOf(() => validateQuestion("a".repeat(201)))).toBe("invalid_question");
    expect(codeOf(() => validateQuestion(`   ${"a".repeat(9)}   `))).toBe("invalid_question");
  });

  it("refuses control characters and lone surrogates", () => {
    expect(codeOf(() => validateQuestion("Will it\nrain tomorrow?"))).toBe("invalid_question");
    expect(codeOf(() => validateQuestion("Will it rain\u0000 tomorrow?"))).toBe("invalid_question");
    expect(codeOf(() => validateQuestion("Will it rain \ud800 tomorrow?"))).toBe("invalid_question");
  });
});

describe("validateDescription", () => {
  it("defaults to empty, trims, and allows tabs and line breaks", () => {
    expect(validateDescription(undefined)).toBe("");
    expect(validateDescription("  Rules:\n\t1. Official data.\r\n  ")).toBe("Rules:\n\t1. Official data.");
    expect(validateDescription("x".repeat(2000))).toHaveLength(2000);
  });

  it("refuses more than 2000 characters, other controls and lone surrogates", () => {
    expect(codeOf(() => validateDescription("x".repeat(2001)))).toBe("invalid_description");
    expect(codeOf(() => validateDescription("bell \u0007"))).toBe("invalid_description");
    expect(codeOf(() => validateDescription("half \udc00"))).toBe("invalid_description");
  });
});

describe("parseDateTime and validateCloseTime", () => {
  it("reads RFC 3339 times with a zone and refuses anything else", () => {
    expect(parseDateTime("2026-11-02T10:00:00Z")?.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(parseDateTime("2026-11-02T11:30:00.250+01:30")?.toISOString()).toBe("2026-11-02T10:00:00.250Z");
    expect(parseDateTime("2026-11-02t10:00:00z")?.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    for (const bad of ["2026-11-02T10:00:00", "2026-11-02", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-02T24:00:00Z", "2026-11-02T10:60:00Z", "2026-11-02T10:00:00+24:00", "now"]) {
      expect(parseDateTime(bad), bad).toBeNull();
    }
    expect(parseDateTime("2028-02-29T00:00:00Z")).not.toBeNull();
  });

  it("needs a close time later than now plus the lead and at most 366 days ahead", () => {
    const lead = 5 * 60_000;
    expect(codeOf(() => validateCloseTime("2026-11-01T10:05:00Z", now, lead))).toBe("invalid_close_time");
    expect(validateCloseTime("2026-11-01T10:05:00.001Z", now, lead).toISOString()).toBe("2026-11-01T10:05:00.001Z");
    const last = new Date(now.getTime() + MAX_CLOSE_AHEAD_MS).toISOString();
    expect(validateCloseTime(last, now, lead).toISOString()).toBe(last);
    const tooLate = new Date(now.getTime() + MAX_CLOSE_AHEAD_MS + 1).toISOString();
    expect(codeOf(() => validateCloseTime(tooLate, now, lead))).toBe("invalid_close_time");
    expect(codeOf(() => validateCloseTime("2026-10-01T00:00:00Z", now, 0))).toBe("invalid_close_time");
  });
});

describe("validateStartingPrice", () => {
  it("accepts every price with two decimals from 0.01 to 0.99", () => {
    for (let cents = 1; cents <= 99; cents += 1) {
      const price = Number(`0.${String(cents).padStart(2, "0")}`);
      expect(validateStartingPrice(price)).toBe(price);
    }
    expect(validateStartingPrice(0.5)).toBe(0.5);
  });

  it("refuses more decimals, the bounds 0 and 1, and anything that is not a finite number", () => {
    for (const bad of [0, 1, 0.001, 0.295, 0.29000001, 0.999, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined]) {
      expect(codeOf(() => validateStartingPrice(bad)), String(bad)).toBe("invalid_starting_price");
    }
  });

  it("gives NO the rest of 1 without a floating point remainder", () => {
    expect(noStartingPrice(0.35)).toBe(0.65);
    expect(noStartingPrice(0.29)).toBe(0.71);
    expect(noStartingPrice(0.01)).toBe(0.99);
  });
});

describe("validateFundingAmount", () => {
  it("accepts whole credits within the configured bounds", () => {
    expect(validateFundingAmount(100, rules)).toBe(100);
    expect(validateFundingAmount(100_000, rules)).toBe(100_000);
    for (const bad of [99, 100_001, 150.5, 0, -100, "1000", Number.NaN, 2 ** 53]) {
      expect(codeOf(() => validateFundingAmount(bad, rules)), String(bad)).toBe("invalid_funding_amount");
    }
  });
});

describe("outcomes and statuses", () => {
  it("knows exactly YES, NO and INVALID, and the five statuses", () => {
    expect(isOutcome("YES") && isOutcome("NO") && isOutcome("INVALID")).toBe(true);
    expect(isOutcome("yes")).toBe(false);
    expect(isOutcome("invalid")).toBe(false);
    expect(parseOutcome("NO")).toBe("NO");
    expect(parseOutcome("INVALID")).toBe("INVALID");
    expect(codeOf(() => parseOutcome("MAYBE"))).toBe("invalid_outcome");
    expect(["draft", "opening", "open", "closed", "resolved"].every(isMarketStatus)).toBe(true);
    expect(isMarketStatus("cancelled")).toBe(false);
  });
});

describe("the state machine", () => {
  const draft = newMarket(input, rules);
  const later = new Date("2026-11-01T11:00:00.000Z");

  it("allows exactly the transitions of DM-19", () => {
    const statuses: MarketStatus[] = ["draft", "opening", "open", "closed", "resolved"];
    const allowed = statuses.flatMap((from) => statuses.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(allowed.sort()).toEqual(["closed->resolved", "draft->opening", "open->closed", "opening->draft", "opening->open"]);
  });

  it("walks a market from draft to resolved, one version per step", () => {
    const opening = beginOpening(draft, later);
    expect(opening).toMatchObject({ status: "opening", version: 2, updatedAt: later, openedAt: null });
    const open = completeOpening(opening, later);
    expect(open).toMatchObject({ status: "open", version: 3, openedAt: later });
    const closed = closeMarket(open, "admin-2", later);
    expect(closed).toMatchObject({ status: "closed", version: 4, closedAt: later, closedBy: "admin-2" });
    const resolved = resolveMarket(closed, "YES", "admin-3", later);
    expect(resolved).toMatchObject({ status: "resolved", version: 5, outcome: "YES", resolvedAt: later, resolvedBy: "admin-3" });
    expect(draft).toMatchObject({ status: "draft", version: 1 });
  });

  it("returns an opening market to draft when the funding failed", () => {
    expect(revertOpening(beginOpening(draft, later), later)).toMatchObject({ status: "draft", version: 3, openedAt: null });
  });

  it("refuses every other transition", () => {
    const open = completeOpening(beginOpening(draft, later), later);
    expect(codeOf(() => completeOpening(draft, later))).toBe("invalid_transition");
    expect(codeOf(() => revertOpening(draft, later))).toBe("invalid_transition");
    expect(codeOf(() => closeMarket(draft, "a", later))).toBe("invalid_transition");
    expect(codeOf(() => beginOpening(open, later))).toBe("invalid_transition");
    expect(codeOf(() => resolveMarket(open, "NO", "a", later))).toBe("invalid_transition");
    const resolved = resolveMarket(closeMarket(open, "a", later), "NO", "a", later);
    expect(codeOf(() => closeMarket(resolved, "a", later))).toBe("invalid_transition");
  });

  it("resolves a closed market as INVALID with the same transition rules: version + 1, resolver kept", () => {
    const closed = closeMarket(completeOpening(beginOpening(draft, later), later), "a", later);
    expect(resolveMarket(closed, "INVALID", "admin-3", later)).toMatchObject({ status: "resolved", version: 5, outcome: "INVALID", resolvedBy: "admin-3" });
    expect(codeOf(() => resolveMarket(completeOpening(beginOpening(draft, later), later), "INVALID", "a", later))).toBe("invalid_transition");
  });

  it("refuses an unknown outcome", () => {
    const closed = closeMarket(completeOpening(beginOpening(draft, later), later), "a", later);
    expect(codeOf(() => resolveMarket(closed, "MAYBE" as Outcome, "a", later))).toBe("invalid_outcome");
  });
});
