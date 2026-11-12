import type { AutoCloseSettings } from "../../config.js";
import type { Logger, Store } from "../../usecases/ports.js";
import type { CloseDueMarketsUseCase } from "../../usecases/use-cases.js";

/** Markets closed per tenant and run at most; a tenant whose whole batch was closed continues at once in the next run. */
export const AUTO_CLOSE_BATCH = 50;
/** The longest single sleep: a change of AUTO_CLOSE_INTERVAL_MS (runtime key) applies within this time. */
export const AUTO_CLOSE_MAX_SLICE_MS = 5000;

export interface AutoCloseWorkerOptions {
  store: Store;
  close: CloseDueMarketsUseCase;
  logger: Logger;
  /** The settings in force now. Read at every run and while waiting, so a runtime change (ADR-037) applies without a restart. */
  settings: () => AutoCloseSettings;
  /** Markets closed per tenant and run. Default 50 (AUTO_CLOSE_BATCH). */
  batchSize?: number;
  /** The longest single sleep between two looks at the settings. Default 5 s (AUTO_CLOSE_MAX_SLICE_MS). */
  maxSliceMs?: number;
}

export interface AutoCloseRunResult {
  /** True when AUTO_CLOSE_ENABLED is false: nothing was looked at. */
  skipped: boolean;
  /** Tenants visited. */
  tenants: number;
  /** Markets closed in this run. */
  closed: number;
  /** Markets that failed (they stay open and are tried again at the next run). */
  failedMarkets: number;
  /** Tenants whose markets could not be read at all (the other tenants went on). */
  failedTenants: number;
  /** A tenant closed a whole batch: more markets may be due, so the next run starts at once. A run with a failure does not set it. */
  more: boolean;
}

const idle = (skipped: boolean): AutoCloseRunResult => ({ skipped, tenants: 0, closed: 0, failedMarkets: 0, failedTenants: 0, more: false });

/**
 * UC-15: the background loop that closes markets at their close time, shaped like the opening-retry worker. Every
 * AUTO_CLOSE_INTERVAL_MS it reads the registry of tenants (one cheap query: shared.tenant_registry; each tenant's check
 * is then one probe of its partial index, see CloseDueMarkets) and has the use case close the due markets of each tenant.
 * Several instances run it at the same time: the claim of a due market is FOR UPDATE SKIP LOCKED, so a market is closed
 * by exactly one of them. A scan of the registry instead of a shared index of deadlines keeps one source of truth (the
 * markets themselves), at the price of one probe per tenant per run.
 *
 * The kill switch AUTO_CLOSE_ENABLED is read at every run and between tenants: false closes nothing (the loop keeps
 * running and notices when the switch goes back to true, within one interval). One tenant that fails (a missing schema, a
 * database error) is logged and does not stop the others; inside a tenant the use case isolates a failing market the same
 * way. A shutdown finishes the market in progress and nothing more: the use case is asked before each market whether
 * the worker is stopping, so the rest of a tenant's batch stays open for the next run.
 */
export class AutoCloseWorker {
  private readonly batchSize: number;
  private readonly maxSliceMs: number;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  /** Whether the "switched off" notice was logged for the current off period. */
  private offLogged = false;

  constructor(private readonly options: AutoCloseWorkerOptions) {
    this.batchSize = options.batchSize ?? AUTO_CLOSE_BATCH;
    this.maxSliceMs = options.maxSliceMs ?? AUTO_CLOSE_MAX_SLICE_MS;
  }

  /** One run over all tenants. */
  async runOnce(): Promise<AutoCloseRunResult> {
    const { store, close, logger, settings } = this.options;
    if (!settings().enabled) {
      if (!this.offLogged) logger.warn({}, "AUTO_CLOSE_ENABLED is false: markets are not closed automatically until it is true");
      this.offLogged = true;
      return idle(true);
    }
    if (this.offLogged) logger.info({}, "AUTO_CLOSE_ENABLED is true again: closing markets automatically");
    this.offLogged = false;

    const result = idle(false);
    for (const tenantId of await store.repositories.tenants.listTenantIds()) {
      if (this.stopping || !settings().enabled) break;
      result.tenants += 1;
      try {
        const outcome = await close.execute({ tenantId, limit: this.batchSize, shouldStop: () => this.stopping });
        result.closed += outcome.closed;
        result.failedMarkets += outcome.failed;
        if (outcome.more) result.more = true;
      } catch (error) {
        result.failedTenants += 1;
        logger.error({ tenantId, err: error }, "Closing the due markets of a tenant failed; the other tenants go on");
      }
    }
    return result;
  }

  /** Starts the polling loop; it runs until stop() is called. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Stops the loop and waits until the market in progress has finished. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
    this.stopping = false;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let wait = (): number => this.options.settings().intervalMs;
      try {
        const result = await this.runOnce();
        failures = 0;
        // A tenant that closed a whole batch probably has more due: go on at once. After a failure the interval applies.
        if (result.more) wait = () => 0;
      } catch (error) {
        failures += 1;
        const attempt = failures;
        wait = () => Math.min(30_000, this.options.settings().intervalMs * 2 ** Math.min(attempt, 16));
        this.options.logger.error({ err: error }, "The automatic close could not read the registry of tenants");
      }
      await this.pause(wait);
    }
  }

  /** Waits until `target()` milliseconds have passed, in slices, so that a changed interval applies within a slice. */
  private async pause(target: () => number): Promise<void> {
    let waited = 0;
    while (!this.stopping) {
      const remaining = target() - waited;
      if (remaining <= 0) return;
      const slice = Math.min(remaining, this.maxSliceMs);
      await this.sleep(slice);
      waited += slice;
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
