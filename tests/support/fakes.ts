import { createHash } from "node:crypto";
import type { Actor, Clock, IdGenerator, Logger, MarketRole, ShareTokenGenerator } from "../../src/usecases/ports.js";

// Test doubles shared by the use-case, adapter and web tests.

/** Share tokens that are valid (43 characters of base64url), different from each other and predictable by their number. */
export class SequentialTokens implements ShareTokenGenerator {
  private counter = 0;
  /** The token that number `n` (1, 2, ...) is or will be. */
  static tokenNumber(n: number): string {
    return createHash("sha256").update(`share-token-${n}`).digest().toString("base64url");
  }
  newToken(): string {
    this.counter += 1;
    return SequentialTokens.tokenNumber(this.counter);
  }
}

export const TENANT_A = "018f3c1e-7a00-7000-8000-0000000000aa";
export const TENANT_B = "018f3c1e-7a00-7000-8000-0000000000bb";

export class TestClock implements Clock {
  constructor(private current = new Date("2026-11-01T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Moves forward by a millisecond so that rows written one after another sort in a known order. */
  tick(): void {
    this.advanceMs(1);
  }
}

/** Ids that are valid UUIDs, grow like UUIDv7 and are predictable: ...0001, ...0002 */
export class SequentialIds implements IdGenerator {
  private counter = 0;
  newId(): string {
    this.counter += 1;
    return `00000000-0000-7000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
  messages(level?: string): Array<string | undefined> {
    return this.lines.filter((line) => level === undefined || line.level === level).map((line) => line.message);
  }
}

/** A caller of the market endpoints, as the web layer builds it from a token. */
export function actor(userId: string, role: MarketRole = "tenant-admin", tenantId = TENANT_A): Actor {
  return { userId, role, tenantId, correlationId: `corr-${userId}`, causationId: `req-${userId}` };
}

/** A close time `hours` after the clock's time, as the API takes it. */
export function closeTimeIn(clock: Clock, hours: number): string {
  return new Date(clock.now().getTime() + hours * 3_600_000).toISOString();
}
