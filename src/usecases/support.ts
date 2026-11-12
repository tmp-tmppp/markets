import { natsSubject } from "../domain/events.js";
import type { CloudEvent, EventContext, EventName } from "../domain/events.js";
import { MARKET_STATUSES, TRADER_VISIBLE_STATUSES } from "../domain/market.js";
import type { MarketStatus } from "../domain/market.js";
import { Forbidden, ValidationFailed } from "./errors.js";
import type { Caller, IdGenerator, MarketRole, OutboxMessage } from "./ports.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** The inbox consumer name of the TenantCreated handler (shared.inbox.consumer). */
export const TENANT_CREATED_CONSUMER = "tenant-created";

// The opening saga (DM-19). The worker claims PENDING_OPENING_BATCH rows every OPENING_RETRY_INTERVAL_MS and leases
// them for OPENING_LEASE_MS; the request that begins an opening leases its own row for the same time.
export const OPENING_LEASE_MS = 60_000;
export const PENDING_OPENING_BATCH = 5;
/** The longest wait between two funding calls whose outcome stayed unknown. */
export const OPENING_MAX_RETRY_DELAY_MS = 300_000;

/**
 * The wait before the next funding call of a market whose outcome is still unknown, given the number of unknown
 * outcomes so far (the attempts after this one was counted): 2 s, 4 s, 8 s ... at most 300 s. It never gives up:
 * the Idempotency-Key makes every repeat safe.
 */
export function openingRetryDelayMs(attempts: number): number {
  const exponent = Math.max(1, Math.min(attempts, 30));
  return Math.min(2 ** exponent * 1000, OPENING_MAX_RETRY_DELAY_MS);
}

/** The Idempotency-Key of a market's funding call: the market id, the same for the request and every retry. */
export function fundingIdempotencyKey(marketId: string): string {
  return marketId;
}

export function eventContext(deps: { ids: IdGenerator }, caller: Pick<Caller, "correlationId" | "causationId">, now: Date): EventContext {
  return { eventId: deps.ids.newId(), now, correlationId: caller.correlationId, causationId: caller.causationId };
}

export function outboxMessage(name: EventName, event: CloudEvent<unknown>, aggregateId: string, now: Date): OutboxMessage {
  return {
    id: event.id,
    aggregateId,
    subject: natsSubject(name, event.tenantid),
    type: event.type,
    payload: event,
    createdAt: now,
  };
}

/** Whether a role may see a market in this status: traders see open, closed and resolved markets only. */
export function canSee(role: MarketRole, status: MarketStatus): boolean {
  return role === "tenant-admin" || TRADER_VISIBLE_STATUSES.includes(status);
}

/**
 * The statuses a list returns: the requested one, or every status the role may see. A trader who asks for draft or
 * opening is refused (403), so the filter cannot be used to learn about hidden markets.
 */
export function visibleStatuses(role: MarketRole, requested: MarketStatus | undefined): MarketStatus[] {
  if (requested === undefined) return role === "tenant-admin" ? [...MARKET_STATUSES] : [...TRADER_VISIBLE_STATUSES];
  if (!canSee(role, requested)) throw new Forbidden(`A trader cannot list ${requested} markets`);
  return [requested];
}

/** Write actions (create, open, close, resolve) are for tenant admins only. */
export function requireTenantAdmin(role: MarketRole): void {
  if (role !== "tenant-admin") throw new Forbidden("The tenant-admin role is required");
}

// Cursors are opaque to clients: base64url of {"k": the id of the last market of the page}. The list is ordered by id
// (newest first), so the id alone is the position. A client can still craft one, and the id ends up as an SQL
// parameter cast to uuid, so it is checked completely: a bad cursor is a 400, never a database error.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(lastId: string): string {
  return Buffer.from(JSON.stringify({ k: lastId }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k?: unknown };
    if (typeof parsed.k === "string" && UUID_PATTERN.test(parsed.k)) return parsed.k.toLowerCase();
  } catch {
    // Falls through to the validation error below.
  }
  throw new ValidationFailed([{ field: "cursor", message: "The cursor is not valid" }]);
}

export interface PageInput {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/** Reads one page by asking for one row more than the limit; that row tells whether another page follows. */
export async function readPage<T>(
  input: PageInput,
  fetchRows: (limit: number, beforeId: string | null) => Promise<T[]>,
  idOf: (row: T) => string,
): Promise<PageOf<T>> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationFailed([{ field: "limit", message: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` }]);
  }
  const rows = await fetchRows(limit + 1, decodeCursor(input.cursor));
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(idOf(last)) : null;
  return { items, nextCursor };
}
