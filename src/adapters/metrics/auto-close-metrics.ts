// The one metric that is specific to markets: what the automatic close at the close time (UC-15) did. It sits on the
// same registry as the HTTP metrics of src/adapters/metrics/metrics.ts and follows the same convention (prom-client 15,
// bounded labels).
//
//   markets_auto_close_total{outcome}  (counter)
//     outcome="closed"         markets the worker closed at their close time
//     outcome="market_failed"  markets whose close failed (they stay open and are tried again at the next run)
//     outcome="tenant_failed"  tenants whose markets could not be read at all in a run (the other tenants went on)
//
// The label has exactly these three values: no tenant id and no market id, so the cardinality never grows with the data.

import { Counter } from "prom-client";
import type { Registry } from "prom-client";
import type { CloseDueMarketsInput, CloseDueMarketsResult, CloseDueMarketsUseCase } from "../../usecases/use-cases.js";

export const AUTO_CLOSE_METRIC = "markets_auto_close_total";
export const AUTO_CLOSE_OUTCOMES = ["closed", "market_failed", "tenant_failed"] as const;
export type AutoCloseOutcome = (typeof AUTO_CLOSE_OUTCOMES)[number];

/** Registers the counter on `registry`, with every outcome at 0 from the start so that rate() has a series to read. */
export function createAutoCloseCounter(registry: Registry): Counter<"outcome"> {
  const counter = new Counter({
    name: AUTO_CLOSE_METRIC,
    help: "Markets handled by the automatic close at the close time, by outcome: closed, market_failed or tenant_failed.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  for (const outcome of AUTO_CLOSE_OUTCOMES) counter.inc({ outcome }, 0);
  return counter;
}

/**
 * The close-due use case with its outcomes counted. The result and the error pass through unchanged: a failing tenant
 * (the use case throws only when the tenant's markets cannot be read at all) is counted and thrown again, so the worker
 * isolates it as before.
 */
export class MeteredCloseDueMarkets implements CloseDueMarketsUseCase {
  constructor(
    private readonly inner: CloseDueMarketsUseCase,
    private readonly counter: Counter<"outcome">,
  ) {}

  async execute(input: CloseDueMarketsInput): Promise<CloseDueMarketsResult> {
    let result: CloseDueMarketsResult;
    try {
      result = await this.inner.execute(input);
    } catch (error) {
      this.counter.inc({ outcome: "tenant_failed" });
      throw error;
    }
    if (result.closed > 0) this.counter.inc({ outcome: "closed" }, result.closed);
    if (result.failed > 0) this.counter.inc({ outcome: "market_failed" }, result.failed);
    return result;
  }
}
