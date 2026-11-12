import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  ExponentialBackoff,
  IsolatedCircuitError,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  wrap,
} from "cockatiel";
import { FUNDING_RETRY_MAX_DELAY_MS } from "../../config.js";
import type { FundingPolicyConfig } from "../../config.js";
import type { FundingClient, FundingRequest, FundingResult, Logger } from "../../usecases/ports.js";
import { TokenUnavailable } from "./token-provider.js";
import type { AccessTokenSource } from "./token-provider.js";

export interface TradingFundingClientOptions {
  /** Base URL of trading's internal service, for example http://trading:8080. */
  baseUrl: string;
  tokens: AccessTokenSource;
  policy: FundingPolicyConfig;
  logger: Logger;
  fetch?: typeof fetch;
  /** First and largest wait between attempts (exponential backoff with jitter). Defaults 250 and 2000. */
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
}

/** Seconds a caller is told to wait when no service token could be had; the circuit's own wait is the half-open time. */
const TOKEN_RETRY_AFTER_SECONDS = 5;
const ENDPOINT = "/v1/internal/market-funding";
const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";
const INSUFFICIENT_CREDITS_TYPE = "urn:chance:problem:insufficient-credits";
/** 409 while the first call with the same Idempotency-Key is still being processed: transient, never a refusal. */
const IN_PROGRESS_CODE = "idempotency_in_progress";
/** The part of a problem's text that is kept, for logs and for the 502 detail. */
const DETAIL_MAX_LENGTH = 200;

/** A status that says "try again": the same call may succeed a moment later. */
class TransientStatus extends Error {
  constructor(readonly status: number) {
    super(`trading answered ${status}`);
    this.name = "TransientStatus";
  }
}

/** Worth another attempt: trading was not reached, was too slow, or said it cannot take the call now. */
function isTransient(error: unknown): boolean {
  if (error instanceof TransientStatus || error instanceof TaskCancelledError) return true;
  // fetch rejects with a TypeError when the network fails and with an AbortError or TimeoutError when it is aborted.
  return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/** A short description of a failure for the log and for the reason of an `unknown` result. Never holds a token. */
function describeFailure(error: unknown): string {
  if (error instanceof TransientStatus) return error.message;
  if (error instanceof TaskCancelledError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
    return "trading did not answer in time";
  }
  if (error instanceof TypeError) {
    const cause: unknown = error.cause;
    const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : null;
    return `trading cannot be reached (${code ?? error.message})`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface Problem {
  code: string | null;
  type: string | null;
  detail: string | null;
}

/** The code, type and detail of an RFC 9457 body; an unreadable or other body gives nulls. */
async function readProblem(response: Response): Promise<Problem> {
  const none: Problem = { code: null, type: null, detail: null };
  try {
    const body: unknown = JSON.parse((await response.text()).slice(0, 8192));
    if (!isRecord(body)) return none;
    const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
    return { code: text(body["code"]), type: text(body["type"]), detail: text(body["detail"]) ?? text(body["title"]) };
  } catch {
    return none;
  }
}

/**
 * FundingClient over trading's internal endpoint (contracts/outgoing/trading-market-funding.openapi.yaml, plan DM-19):
 * POST /v1/internal/market-funding with the market id as Idempotency-Key and the service token of the client `markets`.
 *
 * One resilience policy per instance (REL-04): a retry with exponential backoff and jitter, a circuit breaker and a
 * timeout per attempt, outermost first. Only network errors, timeouts, 408, 429, 409 idempotency_in_progress and 5xx count as failures and are
 * retried; every other answer of trading is a result, so it also tells the breaker that trading is up.
 *
 * The result, never an exception: funded (200, 201); insufficient_credits (409 with that problem code); rejected (any
 * other 4xx, trading refused and took nothing; except a 401 or 403 to a repeat after a sent attempt, which is unknown); not_sent (the circuit is open or no service token could be had, before
 * any request left); unknown (failures after the retries, or an answer that is none of the above, so trading may or may
 * not have taken the credits). The caller repeats an unknown outcome with the same key, which makes it safe.
 */
export class TradingFundingClient implements FundingClient {
  private readonly url: string;
  private readonly http: typeof fetch;
  private readonly policy;

  constructor(private readonly options: TradingFundingClientOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}${ENDPOINT}`;
    this.http = options.fetch ?? fetch;
    const { policy } = options;
    this.policy = wrap(
      retry(handleWhen(isTransient), {
        maxAttempts: policy.retries,
        backoff: new ExponentialBackoff({ initialDelay: options.retryInitialDelayMs ?? 250, maxDelay: options.retryMaxDelayMs ?? FUNDING_RETRY_MAX_DELAY_MS }),
      }),
      circuitBreaker(handleWhen(isTransient), {
        halfOpenAfter: policy.circuitHalfOpenMs,
        breaker: new ConsecutiveBreaker(policy.circuitFailures),
      }),
      timeout(policy.timeoutMs, TimeoutStrategy.Aggressive),
    );
  }

  async fund(request: FundingRequest, idempotencyKey: string): Promise<FundingResult> {
    const fields = { tenantId: request.tenantId, marketId: request.marketId };
    let attempts = 0;
    // True once a request with the funding left this process: from then on a failure is an unknown outcome, never "not sent".
    let sent = false;
    let lastFailure = "";
    try {
      const result = await this.policy.execute(async ({ signal }): Promise<FundingResult> => {
        attempts += 1;
        try {
          const token = await this.options.tokens.token();
          // An answer to a repeat of this call is judged knowing that an earlier attempt may have been booked.
          const repeat = sent;
          sent = true;
          const response = await this.http(this.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "idempotency-key": idempotencyKey,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              marketId: request.marketId,
              tenantId: request.tenantId,
              creatorId: request.creatorId,
              amount: request.amount,
            }),
            // A redirect would carry the bearer token to another address: it is an answer to look at, not to follow.
            redirect: "manual",
            signal,
          });
          return await this.interpret(response, repeat);
        } catch (error) {
          lastFailure = describeFailure(error);
          throw error;
        }
      });
      this.logResult(fields, attempts, result);
      return result;
    } catch (error) {
      return this.failed(error, fields, attempts, sent, lastFailure);
    }
  }

  /**
   * Turns one answer into a result, or throws TransientStatus for the answers that are worth repeating. `repeat` is true
   * when an earlier attempt of the same call was sent: a 401 or 403 then says nothing about that attempt (trading's
   * authentication answers before it looks at the Idempotency-Key), so the outcome stays unknown.
   */
  private async interpret(response: Response, repeat: boolean): Promise<FundingResult> {
    const { status } = response;
    if (status === 200 || status === 201) {
      await response.body?.cancel();
      return { kind: "funded" };
    }
    if (status === 408 || status === 429 || status >= 500) {
      await response.body?.cancel();
      throw new TransientStatus(status);
    }
    if (status >= 400) {
      const problem = await readProblem(response);
      if (status === 409 && (problem.code === INSUFFICIENT_CREDITS_CODE || problem.type === INSUFFICIENT_CREDITS_TYPE)) {
        return { kind: "insufficient_credits" };
      }
      // A repeat with the same key that arrives while the first call with it still runs: the first may yet be booked.
      if (status === 409 && problem.code === IN_PROGRESS_CODE) throw new TransientStatus(status);
      // The cached token may have been revoked: the next call fetches a new one.
      if (status === 401) this.options.tokens.invalidate?.();
      if (repeat && (status === 401 || status === 403)) {
        return { kind: "unknown", reason: `trading refused the authentication (${status}) of a repeat; an earlier attempt may have been booked` };
      }
      return { kind: "rejected", status, detail: (problem.detail ?? `trading answered ${status}`).slice(0, DETAIL_MAX_LENGTH) };
    }
    // 1xx, other 2xx and 3xx: not an answer this contract has, so what trading did is not known.
    await response.body?.cancel();
    return { kind: "unknown", reason: `trading answered with the unexpected status ${status}` };
  }

  private failed(error: unknown, fields: object, attempts: number, sent: boolean, lastFailure: string): FundingResult {
    if (error instanceof BrokenCircuitError || error instanceof IsolatedCircuitError) {
      const retryAfterSeconds = Math.ceil(this.options.policy.circuitHalfOpenMs / 1000);
      return this.notSent(fields, attempts, sent, "the circuit to trading is open", retryAfterSeconds, lastFailure);
    }
    if (error instanceof TokenUnavailable) {
      return this.notSent(fields, attempts, sent, `no service token for trading: ${error.message}`, TOKEN_RETRY_AFTER_SECONDS, lastFailure);
    }
    const reason = describeFailure(error);
    if (!isTransient(error)) {
      // Not a failure of trading: a defect in this client. The market stays opening and the worker repeats the call.
      this.options.logger.error({ ...fields, attempts, err: error }, "The funding call failed in an unexpected way");
    } else {
      this.options.logger.warn({ ...fields, attempts, reason }, "The funding outcome is unknown after the retries");
    }
    return { kind: "unknown", reason };
  }

  /** Nothing was sent, unless an earlier attempt of this call was: then the outcome is unknown. */
  private notSent(fields: object, attempts: number, sent: boolean, reason: string, retryAfterSeconds: number, lastFailure: string): FundingResult {
    if (sent) {
      const unknownReason = `${reason} after an attempt was sent (last failure: ${lastFailure || "none"})`;
      this.options.logger.warn({ ...fields, attempts, reason: unknownReason }, "The funding outcome is unknown: the call was cut off");
      return { kind: "unknown", reason: unknownReason };
    }
    this.options.logger.warn({ ...fields, attempts, reason, retryAfterSeconds }, "The funding call was not sent");
    return { kind: "not_sent", reason, retryAfterSeconds };
  }

  private logResult(fields: object, attempts: number, result: FundingResult): void {
    const { logger } = this.options;
    switch (result.kind) {
      case "funded":
      case "insufficient_credits":
        logger.info({ ...fields, attempts, outcome: result.kind }, "Trading answered the funding call");
        break;
      case "rejected":
        logger.warn({ ...fields, attempts, status: result.status, detail: result.detail }, "Trading rejected the funding call");
        break;
      case "unknown":
        logger.warn({ ...fields, attempts, reason: result.reason }, "Trading answered the funding call with an unexpected status");
        break;
      case "not_sent":
        break;
    }
  }
}
