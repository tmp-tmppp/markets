import type { Logger, PendingOpening } from "./ports.js";
import type { FinishOpeningOutcome, FinishOpeningUseCase, RetryOpeningUseCase } from "./use-cases.js";

/**
 * The step of the opening-retry worker for one claimed row of shared.pending_openings: the same FinishOpening as the
 * request ran, with the same Idempotency-Key, so a retry after an unknown outcome is safe (DM-19). It logs each attempt
 * when given a logger (the composition root passes it).
 */
export class RetryOpening implements RetryOpeningUseCase {
  constructor(
    private readonly finishOpening: FinishOpeningUseCase,
    private readonly logger?: Logger,
  ) {}

  async execute(pending: PendingOpening): Promise<FinishOpeningOutcome> {
    const outcome = await this.finishOpening.execute({
      tenantId: pending.tenantId,
      marketId: pending.marketId,
      correlationId: pending.correlationId,
      causationId: pending.causationId,
      attempts: pending.attempts,
      // An earlier call of this opening may have sent the funding, so "not sent" now proves nothing.
      firstCall: false,
    });
    this.logger?.info(
      { tenantId: pending.tenantId, marketId: pending.marketId, correlationId: pending.correlationId, attempts: pending.attempts, outcome: outcome.kind },
      "Opening retry attempt finished",
    );
    return outcome;
  }
}
