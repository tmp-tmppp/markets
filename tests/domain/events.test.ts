import { describe, expect, it } from "vitest";
import { eventType, marketClosedEvent, marketOpenedEvent, marketResolvedEvent, natsSubject } from "../../src/domain/events.js";
import { beginOpening, closeMarket, completeOpening, newMarket, resolveMarket } from "../../src/domain/market.js";

const created = new Date("2026-11-01T10:00:00.000Z");
const at = new Date("2026-11-01T11:00:00.000Z");
const tenantId = "018f3c1e-7a00-7000-8000-0000000000aa";
const draft = newMarket(
  {
    id: "00000000-0000-7000-8000-000000000001",
    tenantId,
    question: "Will it rain in Ljubljana tomorrow?",
    closeTime: "2026-11-02T10:00:00Z",
    startingPrice: 0.35,
    fundingAmount: 1000,
    createdBy: "admin-1",
    now: created,
  },
  { fundingMin: 100, fundingMax: 100_000, minLeadMs: 0 },
);
const open = completeOpening(beginOpening(draft, at), at);
const closed = closeMarket(open, "admin-2", at);
const resolved = resolveMarket(closed, "NO", "admin-3", at);
const ctx = { eventId: "018f3c1e-7a00-7000-8000-000000000099", now: at, correlationId: "corr-1", causationId: "req-1" };

const envelope = {
  specversion: "1.0",
  id: ctx.eventId,
  source: "/chance/markets",
  subject: `market/${draft.id}`,
  time: "2026-11-01T11:00:00.000Z",
  datacontenttype: "application/json",
  tenantid: tenantId,
  correlationid: "corr-1",
  causationid: "req-1",
};

describe("event names", () => {
  it("builds the CloudEvents type and the NATS subject per event and tenant", () => {
    expect(eventType("MarketOpened")).toBe("si.chance.markets.MarketOpened.v1");
    expect(natsSubject("MarketResolved", tenantId)).toBe(`chance.markets.MarketResolved.${tenantId}`);
  });
});

describe("event builders", () => {
  it("MarketOpened carries the market's terms, the creator and the version", () => {
    expect(marketOpenedEvent(open, ctx)).toEqual({
      ...envelope,
      type: "si.chance.markets.MarketOpened.v1",
      data: {
        marketId: draft.id,
        question: "Will it rain in Ljubljana tomorrow?",
        closeTime: "2026-11-02T10:00:00.000Z",
        startingPrice: 0.35,
        fundingAmount: 1000,
        creatorId: "admin-1",
        version: 3,
        openedAt: "2026-11-01T11:00:00.000Z",
      },
    });
  });

  it("MarketClosed and MarketResolved carry ids and times only", () => {
    expect(marketClosedEvent(closed, ctx)).toEqual({
      ...envelope,
      type: "si.chance.markets.MarketClosed.v1",
      data: { marketId: draft.id, version: 4, closedAt: "2026-11-01T11:00:00.000Z", closedBy: "admin-2" },
    });
    expect(marketResolvedEvent(resolved, ctx)).toEqual({
      ...envelope,
      type: "si.chance.markets.MarketResolved.v1",
      data: { marketId: draft.id, outcome: "NO", version: 5, resolvedAt: "2026-11-01T11:00:00.000Z", resolvedBy: "admin-3", creatorId: "admin-1" },
    });
  });

  it("refuses a market that has not made the transition of the event", () => {
    expect(() => marketOpenedEvent(draft, ctx)).toThrow(/MarketOpened needs a market that is open/);
    expect(() => marketClosedEvent(open, ctx)).toThrow(/closed/);
    expect(() => marketResolvedEvent(closed, ctx)).toThrow(/resolved/);
    expect(() => marketOpenedEvent({ ...open, openedAt: null }, ctx)).toThrow(/openedAt/);
  });
});
