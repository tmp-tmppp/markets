import { describe, expect, it } from "vitest";
import { beginOpening, completeOpening } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { OpenMarket } from "../../src/usecases/open-market.js";
import { Conflict, Forbidden, FundingRejected, InsufficientCredits, NotFound, TenantNotReady, TradingUnavailable } from "../../src/usecases/errors.js";
import type { FundingRequest, FundingResult } from "../../src/usecases/ports.js";
import type { FinishOpeningOutcome, FinishOpeningUseCase } from "../../src/usecases/use-cases.js";
import { ADMIN, OTHER_ADMIN, TENANT_A, TENANT_B, createClosedMarket, createCore, createDraft, createOpenMarket, racing, tenantAdmin, trader } from "./core.js";
import type { Core } from "./core.js";

const open = (core: Core, market: Market, by = tenantAdmin()) => core.useCases.openMarket.execute({ actor: by, marketId: market.id });
const stored = (core: Core, id: string): Market => core.store.snapshot().markets.find((market) => market.id === id) as Market;
const OPENED_EVENT = "si.chance.markets.MarketOpened.v1";

describe("OpenMarket, funded", () => {
  it("opens the market: version 3, openedAt, one MarketOpened event, no pending row left", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.clock.advanceMs(1000);

    const result = await open(core, draft);

    expect(result.state).toBe("open");
    expect(result.market).toMatchObject({ status: "open", version: 3, openedAt: core.clock.now(), updatedAt: core.clock.now(), createdBy: ADMIN });
    expect(stored(core, draft.id)).toEqual(result.market);
    const state = core.store.snapshot();
    expect(state.pendingOpenings).toEqual([]);
    expect(state.outbox).toHaveLength(1);
    const row = state.outbox[0];
    expect(row).toMatchObject({
      aggregateId: draft.id,
      subject: `chance.markets.MarketOpened.${TENANT_A}`,
      type: OPENED_EVENT,
      publishedAt: null,
    });
    expect(row?.id).toBe(row?.payload.id);
    expect(row?.payload).toMatchObject({
      specversion: "1.0",
      source: "/chance/markets",
      type: OPENED_EVENT,
      subject: `market/${draft.id}`,
      datacontenttype: "application/json",
      tenantid: TENANT_A,
      correlationid: "corr-admin-1",
      causationid: "req-admin-1",
      time: core.clock.now().toISOString(),
      data: {
        marketId: draft.id,
        question: draft.question,
        closeTime: draft.closeTime.toISOString(),
        startingPrice: 0.4,
        fundingAmount: 500,
        creatorId: ADMIN,
        version: 3,
        openedAt: core.clock.now().toISOString(),
      },
    });
  });

  it("calls trading once, with the market id as Idempotency-Key and the creator's credits as the amount", async () => {
    const core = await createCore();
    const draft = await createDraft(core);

    await open(core, draft);

    expect(core.funding.calls).toEqual([
      { request: { marketId: draft.id, tenantId: TENANT_A, creatorId: ADMIN, amount: 500 }, idempotencyKey: draft.id },
    ]);
  });

  it("holds the pending row, leased for 60 seconds, while the funding call runs, and the market is opening then", async () => {
    let during: { status: string; version: number; lease: Date | null; attempts: number } | undefined;
    const core: Core = await createCore({
      funding: {
        fund: (_request: FundingRequest): Promise<FundingResult> => {
          const state = core.store.snapshot();
          during = { status: state.markets[0]?.status ?? "", version: state.markets[0]?.version ?? 0, lease: state.pendingOpenings[0]?.leaseUntil ?? null, attempts: state.pendingOpenings[0]?.attempts ?? -1 };
          return Promise.resolve({ kind: "funded" });
        },
      },
    });
    const draft = await createDraft(core);

    await open(core, draft);

    expect(during).toEqual({ status: "opening", version: 2, lease: new Date(core.clock.now().getTime() + 60_000), attempts: 0 });
  });

  it("reads the time of the opening after the funding call, which may take seconds", async () => {
    const core: Core = await createCore({
      funding: {
        fund: () => {
          core.clock.advanceMs(2500);
          return Promise.resolve({ kind: "funded" } as const);
        },
      },
    });
    const draft = await createDraft(core);
    const before = core.clock.now();

    const { market } = await open(core, draft);

    expect(market.openedAt?.getTime()).toBe(before.getTime() + 2500);
    expect(market.updatedAt).toEqual(market.openedAt);
  });
});

describe("OpenMarket, funding refused or not possible", () => {
  // Same key on the second open: the outgoing contract stores only a completed funding under a key, so the refusal is not replayed.
  it("insufficient credits: 409 insufficient_credits, back in draft (version 3), row gone, no event; opening again with the same key works", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "insufficient_credits" });

    const attempt = open(core, draft);

    await expect(attempt).rejects.toBeInstanceOf(InsufficientCredits);
    await expect(attempt).rejects.toMatchObject({ kind: "conflict", code: "insufficient_credits" });
    expect(stored(core, draft.id)).toMatchObject({ status: "draft", version: 3, openedAt: null });
    let state = core.store.snapshot();
    expect(state.pendingOpenings).toEqual([]);
    expect(state.outbox).toEqual([]);

    const again = await open(core, draft);

    expect(again.market).toMatchObject({ status: "open", version: 5 });
    state = core.store.snapshot();
    expect(state.outbox.map((row) => row.type)).toEqual([OPENED_EVENT]);
    expect(state.outbox[0]?.payload).toMatchObject({ data: { version: 5 } });
    expect(core.funding.calls.map((call) => call.idempotencyKey)).toEqual([draft.id, draft.id]);
  });

  it("rejected by trading: 502 funding_rejected with the upstream status, back in draft, row gone, an error is logged", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "rejected", status: 422, detail: "idempotency_key_reused" });

    const attempt = open(core, draft);

    await expect(attempt).rejects.toBeInstanceOf(FundingRejected);
    await expect(attempt).rejects.toMatchObject({ kind: "bad_gateway", code: "funding_rejected", upstreamStatus: 422 });
    expect(stored(core, draft.id)).toMatchObject({ status: "draft", version: 3 });
    const state = core.store.snapshot();
    expect(state.pendingOpenings).toEqual([]);
    expect(state.outbox).toEqual([]);
    expect(core.logger.lines.filter((line) => line.level === "error")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ tenantId: TENANT_A, marketId: draft.id, status: 422, detail: "idempotency_key_reused" }) }),
    ]);
  });

  it("not sent (circuit open): 503 trading_unavailable with Retry-After, back in draft, row gone, no event", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "not_sent", reason: "circuit open", retryAfterSeconds: 10 });

    const attempt = open(core, draft);

    await expect(attempt).rejects.toBeInstanceOf(TradingUnavailable);
    await expect(attempt).rejects.toMatchObject({ kind: "unavailable", code: "trading_unavailable", retryAfterSeconds: 10 });
    expect(stored(core, draft.id)).toMatchObject({ status: "draft", version: 3 });
    const state = core.store.snapshot();
    expect(state.pendingOpenings).toEqual([]);
    expect(state.outbox).toEqual([]);
  });
});

describe("OpenMarket, outcome unknown", () => {
  it("stays opening (202): the row is rescheduled 2 seconds ahead with the error, the lease is released, no event", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "unknown", reason: "timeout after 3000 ms" });

    const result = await open(core, draft);

    expect(result.state).toBe("opening");
    expect(result.market).toMatchObject({ status: "opening", version: 2, openedAt: null });
    const state = core.store.snapshot();
    expect(state.markets[0]).toMatchObject({ status: "opening", version: 2 });
    expect(state.pendingOpenings).toEqual([
      {
        tenantId: TENANT_A,
        marketId: draft.id,
        correlationId: "corr-admin-1",
        causationId: "req-admin-1",
        attempts: 1,
        nextAttemptAt: new Date(core.clock.now().getTime() + 2000),
        leaseUntil: null,
        lastError: "timeout after 3000 ms",
        createdAt: core.clock.now(),
      },
    ]);
    expect(state.outbox).toEqual([]);
    expect(core.logger.lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });

  it("a market that is already opening answers opening without a new funding call and without a new row", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "unknown", reason: "timeout" });
    await open(core, draft);

    const again = await open(core, draft);

    expect(again.state).toBe("opening");
    expect(again.market).toMatchObject({ status: "opening", version: 2 });
    expect(core.funding.calls).toHaveLength(1);
    expect(core.store.snapshot().pendingOpenings).toHaveLength(1);
  });

  it("answers opening, without a call, when a concurrent opener won transaction A (the version check)", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    let armed = true;
    const store = racing(core.store, async () => {
      if (!armed) return;
      armed = false;
      const tenant = await core.store.forTenant(TENANT_A);
      await tenant?.transaction(async (repositories) => {
        await repositories.markets.update(beginOpening(draft, core.clock.now()), { status: "draft", version: 1 });
        await repositories.pendingOpenings.add({
          tenantId: TENANT_A,
          marketId: draft.id,
          correlationId: "other",
          causationId: "other",
          now: core.clock.now(),
          leaseUntil: new Date(core.clock.now().getTime() + 60_000),
        });
      });
    });

    const result = await new OpenMarket({ ...core.deps, store }, core.useCases.finishOpening).execute({ actor: tenantAdmin(), marketId: draft.id });

    expect(result).toMatchObject({ state: "opening", market: { status: "opening", version: 2 } });
    expect(core.funding.calls).toEqual([]);
    expect(core.store.snapshot().pendingOpenings).toEqual([expect.objectContaining({ correlationId: "other" })]);
  });

  it("answers 409 when the concurrent opener had already finished: the market is open, nothing is called", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    let armed = true;
    const store = racing(core.store, async () => {
      if (!armed) return;
      armed = false;
      const tenant = await core.store.forTenant(TENANT_A);
      const opening = beginOpening(draft, core.clock.now());
      await tenant?.repositories.markets.update(opening, { status: "draft", version: 1 });
      await tenant?.repositories.markets.update(completeOpening(opening, core.clock.now()), { status: "opening", version: 2 });
    });

    const attempt = new OpenMarket({ ...core.deps, store }, core.useCases.finishOpening).execute({ actor: tenantAdmin(), marketId: draft.id });

    await expect(attempt).rejects.toMatchObject({ kind: "conflict", code: "invalid_state" });
    expect(core.funding.calls).toEqual([]);
    expect(core.store.snapshot().pendingOpenings).toEqual([]);
  });

  it("two requests at once fund the market once: the second one sees it opening or open, never a second call", async () => {
    const core = await createCore();
    const draft = await createDraft(core);

    const results = await Promise.allSettled([open(core, draft), open(core, draft)]);

    expect(core.funding.calls).toHaveLength(1);
    expect((stored(core, draft.id)).status).toBe("open");
    expect(core.store.snapshot().outbox).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });
});

describe("OpenMarket, who may open what", () => {
  it("refuses a trader", async () => {
    const core = await createCore();
    const draft = await createDraft(core);

    await expect(open(core, draft, trader())).rejects.toBeInstanceOf(Forbidden);
    expect(core.funding.calls).toEqual([]);
  });

  it("refuses another tenant admin: only the creator's credits fund a market; nothing changes", async () => {
    const core = await createCore();
    const draft = await createDraft(core, tenantAdmin(ADMIN));

    await expect(open(core, draft, tenantAdmin(OTHER_ADMIN))).rejects.toBeInstanceOf(Forbidden);

    expect(core.funding.calls).toEqual([]);
    expect(stored(core, draft.id)).toMatchObject({ status: "draft", version: 1 });
    expect(core.store.snapshot().pendingOpenings).toEqual([]);
  });

  it("checks the creator before the state: another admin gets 403 for an opening and for an open market too", async () => {
    const core = await createCore();
    const mine = await createDraft(core, tenantAdmin(ADMIN));
    core.funding.enqueue({ kind: "unknown", reason: "timeout" });
    await open(core, mine);
    const done = await createOpenMarket(core, tenantAdmin(ADMIN));

    await expect(open(core, mine, tenantAdmin(OTHER_ADMIN))).rejects.toBeInstanceOf(Forbidden);
    await expect(open(core, done, tenantAdmin(OTHER_ADMIN))).rejects.toBeInstanceOf(Forbidden);
  });

  it("answers 404 for an unknown market and for a market of another tenant", async () => {
    const core = await createCore();
    const draft = await createDraft(core);

    await expect(core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: "00000000-0000-7000-8000-0000000000ff" })).rejects.toBeInstanceOf(NotFound);
    await expect(open(core, draft, tenantAdmin(ADMIN, TENANT_B))).rejects.toBeInstanceOf(NotFound);
    expect(core.funding.calls).toEqual([]);
  });

  it("answers TenantNotReady, after the role check, while the tenant has no schema", async () => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: "00000000-0000-7000-8000-000000000001" })).rejects.toBeInstanceOf(TenantNotReady);
    await expect(core.useCases.openMarket.execute({ actor: trader(), marketId: "00000000-0000-7000-8000-000000000001" })).rejects.toBeInstanceOf(Forbidden);
  });

  it.each([
    ["open", (core: Core) => createOpenMarket(core)],
    ["closed", (core: Core) => createClosedMarket(core)],
  ])("answers 409 invalid_state for a %s market and calls nothing more", async (_status, make) => {
    const core = await createCore();
    const market = await make(core);
    const calls = core.funding.calls.length;

    const attempt = open(core, market);

    await expect(attempt).rejects.toBeInstanceOf(Conflict);
    await expect(attempt).rejects.toMatchObject({ kind: "conflict", code: "invalid_state" });
    expect(core.funding.calls).toHaveLength(calls);
  });

  it("answers 409 invalid_state for a resolved market", async () => {
    const core = await createCore();
    const closed = await createClosedMarket(core);
    await core.useCases.resolveMarket.execute({ actor: tenantAdmin(), marketId: closed.id, outcome: "NO" });

    await expect(open(core, closed)).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("OpenMarket, mapping of the outcome of FinishOpening", () => {
  const withOutcome = (core: Core, outcome: FinishOpeningOutcome) => {
    const finishing: FinishOpeningUseCase = { execute: () => Promise.resolve(outcome) };
    return new OpenMarket(core.deps, finishing);
  };

  it("settled before as open or opening answers that state; as anything else it is a conflict", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    const reread = { ...draft, version: 2 };

    const asOpen = await withOutcome(core, { kind: "settled_before", market: { ...reread, status: "open" } }).execute({ actor: tenantAdmin(), marketId: draft.id });
    expect(asOpen).toMatchObject({ state: "open", market: { status: "open" } });
    const second = await createDraft(core);
    const asOpening = await withOutcome(core, { kind: "settled_before", market: { ...second, status: "opening" } }).execute({ actor: tenantAdmin(), marketId: second.id });
    expect(asOpening).toMatchObject({ state: "opening" });
    const third = await createDraft(core);
    await expect(
      withOutcome(core, { kind: "settled_before", market: { ...third, status: "draft" } }).execute({ actor: tenantAdmin(), marketId: third.id }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("missing is a 404", async () => {
    const core = await createCore();
    const draft = await createDraft(core);

    await expect(withOutcome(core, { kind: "missing" }).execute({ actor: tenantAdmin(), marketId: draft.id })).rejects.toBeInstanceOf(NotFound);
  });
});
