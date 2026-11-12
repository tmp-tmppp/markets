import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { marketClosedEvent } from "../../src/domain/events.js";
import { beginOpening, closeMarket, completeOpening, newMarket } from "../../src/domain/market.js";
import {
  Conflict,
  FundingRejected,
  InsufficientCredits,
  NotFound,
  TENANT_NOT_READY_RETRY_AFTER_SECONDS,
  TenantNotReady,
  TradingUnavailable,
  Unavailable,
  ValidationFailed,
  fromDomainError,
  guardDomain,
} from "../../src/usecases/errors.js";
import {
  MAX_PAGE_SIZE,
  canSee,
  decodeCursor,
  encodeCursor,
  eventContext,
  fundingIdempotencyKey,
  openingRetryDelayMs,
  outboxMessage,
  readPage,
  requireTenantAdmin,
  visibleStatuses,
} from "../../src/usecases/support.js";

const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-7000-8000-00000000000${5 - index}`);

describe("use-case errors", () => {
  it("map each domain rule to validation or to the invalid_state conflict", () => {
    expect(fromDomainError(new DomainError("invalid_question", "too short", "question"))).toMatchObject({
      kind: "validation",
      code: "validation_failed",
      fields: [{ field: "question", message: "too short" }],
    });
    expect(fromDomainError(new DomainError("invalid_tenant_id", "bad"))).toMatchObject({ fields: [{ field: "request" }] });
    expect(fromDomainError(new DomainError("invalid_transition", "A market that is open cannot become opening"))).toMatchObject({
      kind: "conflict",
      code: "invalid_state",
    });
    expect(() => guardDomain(() => { throw new DomainError("invalid_outcome", "no", "outcome"); })).toThrow(ValidationFailed);
    expect(() => guardDomain(() => { throw new Error("bug"); })).toThrow("bug");
    expect(guardDomain(() => 7)).toBe(7);
  });

  it("carry the kinds, codes and Retry-After values the web layer maps", () => {
    expect(new NotFound()).toMatchObject({ kind: "not_found", code: "not_found", name: "NotFound" });
    expect(new Conflict("invalid_state", "x")).toMatchObject({ kind: "conflict" });
    expect(new InsufficientCredits()).toMatchObject({ kind: "conflict", code: "insufficient_credits" });
    expect(new FundingRejected(422)).toMatchObject({ kind: "bad_gateway", code: "funding_rejected", upstreamStatus: 422 });
    const trading = new TradingUnavailable(10);
    expect(trading).toBeInstanceOf(Unavailable);
    expect(trading).toMatchObject({ kind: "unavailable", code: "trading_unavailable", retryAfterSeconds: 10 });
    expect(new TenantNotReady()).toMatchObject({ code: "tenant_not_ready", retryAfterSeconds: TENANT_NOT_READY_RETRY_AFTER_SECONDS });
  });
});

describe("visibility and roles", () => {
  it("shows traders open, closed and resolved markets only", () => {
    expect(canSee("trader", "open") && canSee("trader", "resolved")).toBe(true);
    expect(canSee("trader", "draft") || canSee("trader", "opening")).toBe(false);
    expect(canSee("tenant-admin", "draft")).toBe(true);
    expect(visibleStatuses("trader", undefined)).toEqual(["open", "closed", "resolved"]);
    expect(visibleStatuses("tenant-admin", undefined)).toEqual(["draft", "opening", "open", "closed", "resolved"]);
    expect(visibleStatuses("trader", "closed")).toEqual(["closed"]);
    expect(() => visibleStatuses("trader", "draft")).toThrow(/cannot list draft/);
    expect(() => requireTenantAdmin("trader")).toThrow(/tenant-admin/);
    expect(() => requireTenantAdmin("tenant-admin")).not.toThrow();
  });
});

describe("the opening retry schedule", () => {
  it("doubles from 2 seconds up to 300 seconds and never gives up", () => {
    expect([0, 1, 2, 3, 8, 9, 50].map(openingRetryDelayMs)).toEqual([2000, 2000, 4000, 8000, 256_000, 300_000, 300_000]);
    expect(fundingIdempotencyKey(ids[0]!)).toBe(ids[0]);
  });
});

describe("events into the outbox", () => {
  it("files the event under its subject with its id as the message id", () => {
    const now = new Date("2026-11-01T10:00:00.000Z");
    const draft = newMarket(
      { id: ids[0]!, tenantId: "018f3c1e-7a00-7000-8000-0000000000aa", question: "Will the bridge open in May?", closeTime: "2026-12-01T00:00:00Z", startingPrice: 0.5, fundingAmount: 100, createdBy: "a", now },
      { fundingMin: 1, fundingMax: 1000, minLeadMs: 0 },
    );
    const closed = closeMarket(completeOpening(beginOpening(draft, now), now), "a", now);
    const ctx = eventContext({ ids: { newId: () => ids[1]! } }, { correlationId: "corr", causationId: "req" }, now);
    const message = outboxMessage("MarketClosed", marketClosedEvent(closed, ctx), closed.id, now);
    expect(message).toMatchObject({
      id: ids[1],
      aggregateId: ids[0],
      subject: "chance.markets.MarketClosed.018f3c1e-7a00-7000-8000-0000000000aa",
      type: "si.chance.markets.MarketClosed.v1",
      createdAt: now,
    });
    expect(message.payload.correlationid).toBe("corr");
  });
});

describe("cursor pagination", () => {
  const fetchRows = (limit: number, beforeId: string | null) =>
    Promise.resolve(ids.filter((id) => beforeId === null || id < beforeId).slice(0, limit));

  it("pages through ids newest first and ends with a null cursor", async () => {
    const first = await readPage({ limit: 2 }, fetchRows, (id) => id);
    expect(first.items).toEqual(ids.slice(0, 2));
    const second = await readPage({ limit: 2, cursor: first.nextCursor ?? undefined }, fetchRows, (id) => id);
    expect(second.items).toEqual(ids.slice(2, 4));
    const last = await readPage({ limit: 2, cursor: second.nextCursor ?? undefined }, fetchRows, (id) => id);
    expect(last).toEqual({ items: ids.slice(4), nextCursor: null });
    expect((await readPage({}, fetchRows, (id) => id)).items).toHaveLength(5);
  });

  it("refuses a bad limit or a crafted cursor with a validation error", async () => {
    await expect(readPage({ limit: 0 }, fetchRows, (id) => id)).rejects.toThrow(ValidationFailed);
    await expect(readPage({ limit: MAX_PAGE_SIZE + 1 }, fetchRows, (id) => id)).rejects.toThrow(ValidationFailed);
    for (const bad of ["%%%", Buffer.from("[1]").toString("base64url"), Buffer.from('{"k":"1; DROP"}').toString("base64url"), Buffer.from("{}").toString("base64url")]) {
      expect(() => decodeCursor(bad), bad).toThrow(ValidationFailed);
    }
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(encodeCursor(ids[0]!.toUpperCase()))).toBe(ids[0]);
  });
});
