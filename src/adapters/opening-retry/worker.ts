import type { Clock, Logger, Store } from "../../usecases/ports.js";
import { OPENING_LEASE_MS, PENDING_OPENING_BATCH } from "../../usecases/support.js";
import type { RetryOpeningUseCase } from "../../usecases/use-cases.js";

export interface OpeningRetryWorkerOptions {
  store: Store;
  retry: RetryOpeningUseCase;
  clock: Clock;
  logger: Logger;
  /** Wait between polls when nothing is due (OPENING_RETRY_INTERVAL_MS). */
  intervalMs: number;
  /** Rows claimed per poll. Default 5 (PENDING_OPENING_BATCH). */
  batchSize?: number;
  /** How long a claimed row belongs to this worker. Default 60 s (OPENING_LEASE_MS). */
  leaseMs?: number;
  /**
   * The longest one funding call can take (worstFundingCallMs of the policy). A row is started only when a whole call
   * still fits in the rest of the lease. Default 0: only the end of the lease itself stops the batch.
   */
  worstCallMs?: number;
}

export interface RunResult {
  /** Rows taken from shared.pending_openings in this poll. */
  claimed: number;
}

/**
 * Background loop of the opening saga (DM-19), shaped like the identity-sync worker of the tenants service. Every poll
 * claims the due rows of shared.pending_openings (FOR UPDATE SKIP LOCKED, so several instances never get the same row)
 * and leases them, then runs the same "finish opening" use case as the request did, with the same Idempotency-Key: a
 * repeat is safe whatever trading already did. The use case settles the market (open, or back to draft) and deletes the
 * row, or, when the outcome is still unknown, reschedules it with the backoff 2 s ... 300 s. The worker never gives up
 * on a row. One failing row (an unexpected error, such as a database error) is logged and does not stop the others: its
 * lease ends and it is claimed again. The lease must outlast a batch, so the worker also stops starting rows once the
 * lease has less than one whole funding call left (another instance may already hold the rest). A shutdown finishes the row in progress and leaves the
 * others to the lease; they are due again when it ends.
 */
export class OpeningRetryWorker {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly worstCallMs: number;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: OpeningRetryWorkerOptions) {
    this.batchSize = options.batchSize ?? PENDING_OPENING_BATCH;
    this.leaseMs = options.leaseMs ?? OPENING_LEASE_MS;
    this.worstCallMs = options.worstCallMs ?? 0;
  }

  /** One poll: claims a batch and finishes it row by row. */
  async runOnce(): Promise<RunResult> {
    const { store, retry, clock, logger } = this.options;
    const now = clock.now();
    const leaseEnd = new Date(now.getTime() + this.leaseMs);
    const rows = await store.repositories.pendingOpenings.claim(this.batchSize, leaseEnd, now);
    for (const [index, row] of rows.entries()) {
      if (this.stopping) break;
      // A row is started only when one whole funding call still ends inside the lease: after it, another instance may
      // claim the row and send a concurrent call with the same key while this one still runs.
      if (clock.now().getTime() + this.worstCallMs >= leaseEnd.getTime()) {
        logger.warn({ skipped: rows.length - index }, "The lease of the batch ran out; the remaining openings are left for the next claim");
        break;
      }
      try {
        await retry.execute(row);
      } catch (error) {
        logger.error(
          { tenantId: row.tenantId, marketId: row.marketId, correlationId: row.correlationId, attempts: row.attempts, err: error },
          "Finishing an opening failed unexpectedly; it is claimed again when its lease ends",
        );
      }
    }
    return { claimed: rows.length };
  }

  /** Starts the polling loop; it runs until stop() is called. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops the loop and waits until the row in progress has finished. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
    this.stopping = false;
  }

  private async loop(): Promise<void> {
    let storeFailures = 0;
    while (!this.stopping) {
      let delay = this.options.intervalMs;
      try {
        const result = await this.runOnce();
        storeFailures = 0;
        // A full batch means there is probably more due: go on at once.
        if (result.claimed >= this.batchSize) delay = 0;
      } catch (error) {
        storeFailures += 1;
        delay = Math.min(30_000, this.options.intervalMs * 2 ** Math.min(storeFailures, 16));
        this.options.logger.error({ err: error }, "The opening-retry worker could not read or update shared.pending_openings");
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}
