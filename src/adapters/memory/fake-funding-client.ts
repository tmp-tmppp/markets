import type { FakeFundingMode } from "../../config.js";
import type { FundingClient, FundingRequest, FundingResult } from "../../usecases/ports.js";

/**
 * The funding client of local runs and of the use-case tests (no trading service involved). Results queued with
 * `enqueue` are used first, one per call; after that the mode decides: funded, insufficient (credits) or unknown
 * (a timeout, so the market stays opening and the retry worker keeps trying). Like the real client it never throws.
 *
 * It follows the outgoing contract on replay: a key that was answered "funded" is answered "funded" again, before the
 * queue is looked at (trading's 200 for a repeat); an answer that took nothing is not stored, so a later call with the
 * same key is decided anew (a market that went back to draft can be opened again after a top-up).
 */
export class FakeFundingClient implements FundingClient {
  /** Every call, in order, with the Idempotency-Key it carried. */
  readonly calls: Array<{ request: FundingRequest; idempotencyKey: string }> = [];
  private readonly queued: FundingResult[] = [];
  /** The keys whose funding was completed: the only answers trading stores. */
  private readonly fundedKeys = new Set<string>();

  constructor(public mode: FakeFundingMode = "funded") {}

  enqueue(...results: FundingResult[]): void {
    this.queued.push(...results);
  }

  fund(request: FundingRequest, idempotencyKey: string): Promise<FundingResult> {
    this.calls.push({ request: { ...request }, idempotencyKey });
    if (this.fundedKeys.has(idempotencyKey)) return Promise.resolve({ kind: "funded" });
    const result = this.queued.shift() ?? this.byMode();
    if (result.kind === "funded") this.fundedKeys.add(idempotencyKey);
    return Promise.resolve(result);
  }

  private byMode(): FundingResult {
    switch (this.mode) {
      case "funded":
        return { kind: "funded" };
      case "insufficient":
        return { kind: "insufficient_credits" };
      case "unknown":
        return { kind: "unknown", reason: "FAKE_FUNDING_MODE=unknown" };
    }
  }
}
