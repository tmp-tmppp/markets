import { describe, expect, it } from "vitest";
import { FakeFundingClient } from "../../src/adapters/memory/fake-funding-client.js";
import type { FundingRequest } from "../../src/usecases/ports.js";
import { TENANT_A } from "../support/fakes.js";

const request: FundingRequest = { marketId: "m-1", tenantId: TENANT_A, creatorId: "admin-1", amount: 500 };

describe("FakeFundingClient", () => {
  it("funds by default and records every call with its Idempotency-Key", async () => {
    const client = new FakeFundingClient();

    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "funded" });
    await client.fund({ ...request, amount: 600 }, "m-1");

    expect(client.mode).toBe("funded");
    expect(client.calls).toEqual([
      { request, idempotencyKey: "m-1" },
      { request: { ...request, amount: 600 }, idempotencyKey: "m-1" },
    ]);
  });

  it("answers by mode: insufficient credits, or an unknown outcome that names the mode", async () => {
    const client = new FakeFundingClient("insufficient");
    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "insufficient_credits" });

    client.mode = "unknown";
    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "unknown", reason: "FAKE_FUNDING_MODE=unknown" });
  });

  it("uses queued results first, one per call, and then falls back to the mode", async () => {
    const client = new FakeFundingClient("funded");
    client.enqueue({ kind: "not_sent", reason: "circuit open", retryAfterSeconds: 10 }, { kind: "rejected", status: 422, detail: "nope" });

    await expect(client.fund(request, "m-1")).resolves.toMatchObject({ kind: "not_sent", retryAfterSeconds: 10 });
    await expect(client.fund(request, "m-1")).resolves.toMatchObject({ kind: "rejected", status: 422 });
    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "funded" });
    expect(client.calls).toHaveLength(3);
  });

  it("follows the outgoing contract on replay: a funded key is answered funded again before the queue; a refusal is not stored", async () => {
    const client = new FakeFundingClient("insufficient");

    // A refused key is decided anew on every call (the creator topped up and opens the market again).
    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "insufficient_credits" });
    client.mode = "funded";
    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "funded" });

    // A funded key replays, whatever is queued or whatever the mode says now.
    client.mode = "insufficient";
    client.enqueue({ kind: "rejected", status: 422, detail: "nope" });
    await expect(client.fund(request, "m-1")).resolves.toEqual({ kind: "funded" });
    // The queue was not consumed by the replay, and another key is not affected.
    await expect(client.fund(request, "m-2")).resolves.toMatchObject({ kind: "rejected", status: 422 });
    await expect(client.fund(request, "m-2")).resolves.toEqual({ kind: "insufficient_credits" });
  });

  it("copies the request it records, so a later change by the caller does not alter the record", async () => {
    const client = new FakeFundingClient();
    const mutable = { ...request };

    await client.fund(mutable, "m-1");
    mutable.amount = 1;

    expect(client.calls[0]?.request.amount).toBe(500);
  });
});
