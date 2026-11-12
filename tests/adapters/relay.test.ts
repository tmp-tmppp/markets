import { describe, expect, it } from "vitest";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { OutboxRelay } from "../../src/adapters/outbox/relay.js";
import { DAY_MS, DEFAULT_STREAM_MAX_AGE_DAYS, inboxRetentionFor, streamMaxAgeMs } from "../../src/adapters/retention.js";
import { EVENT_SOURCE, eventType, marketSubject, natsSubject } from "../../src/domain/events.js";
import type { CloudEvent } from "../../src/domain/events.js";
import type { OutboxMessage } from "../../src/usecases/ports.js";
import { RecordingLogger, SequentialIds, TENANT_A, TestClock } from "../support/fakes.js";

/** The max age these tests give the stream. The 30 day default is checked in retention.test.ts, config.test.ts and the last tests here. */
const STREAM_MAX_AGE_MS = streamMaxAgeMs(7);

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A store with `count` unpublished MarketClosed events, written one millisecond apart. */
async function coreWithEvents(count: number, maxAgeMs = STREAM_MAX_AGE_MS) {
  const store = new MemoryStore();
  const clock = new TestClock();
  const ids = new SequentialIds();
  const logger = new RecordingLogger();
  const publisher = new MemoryEventPublisher();
  const addEvent = async (label: string): Promise<void> => {
    clock.tick();
    const marketId = ids.newId();
    const event: CloudEvent<unknown> = {
      specversion: "1.0",
      id: ids.newId(),
      source: EVENT_SOURCE,
      type: eventType("MarketClosed"),
      subject: marketSubject(marketId),
      time: clock.now().toISOString(),
      datacontenttype: "application/json",
      tenantid: TENANT_A,
      correlationid: "corr-1",
      causationid: "req-1",
      data: { marketId, version: 3, closedAt: clock.now().toISOString(), closedBy: label },
    };
    const message: OutboxMessage = {
      id: event.id,
      aggregateId: marketId,
      subject: natsSubject("MarketClosed", TENANT_A),
      type: event.type,
      payload: event,
      createdAt: clock.now(),
    };
    await store.transaction((repositories) => repositories.outbox.add(message));
  };
  for (let i = 1; i <= count; i += 1) await addEvent(`event-${i}`);
  const relay = new OutboxRelay({ store, publisher, clock, logger, pollMs: 5, maxBackoffMs: 20, streamMaxAgeMs: maxAgeMs });
  return { store, clock, logger, publisher, relay, addEvent };
}

const labelsOf = (store: MemoryStore) => store.snapshot().outbox.map((row) => (row.payload.data as { closedBy: string }).closedBy);

describe("OutboxRelay", () => {
  it("publishes rows in order, with the event id as message id, and marks them published", async () => {
    const { relay, publisher, store } = await coreWithEvents(3);

    const result = await relay.runOnce();

    expect(result).toEqual({ published: 3, failed: false });
    expect(publisher.published.map((m) => (m.event.data as { closedBy: string }).closedBy)).toEqual(["event-1", "event-2", "event-3"]);
    for (const message of publisher.published) {
      expect(message.messageId).toBe(message.event.id);
      expect(message.subject).toBe(`chance.markets.MarketClosed.${TENANT_A}`);
    }
    expect(store.snapshot().outbox.every((row) => row.publishedAt !== null)).toBe(true);
  });

  it("publishes a row only once", async () => {
    const { relay, publisher } = await coreWithEvents(2);
    await relay.runOnce();
    expect(await relay.runOnce()).toEqual({ published: 0, failed: false });
    expect(publisher.published).toHaveLength(2);
  });

  it("stops the batch at a failed publish, records the attempt and retries later in the same order", async () => {
    const { relay, publisher, store } = await coreWithEvents(3);
    publisher.failNext = 1;

    const first = await relay.runOnce();

    expect(first).toEqual({ published: 0, failed: true });
    const rows = store.snapshot().outbox;
    expect(rows[0]).toMatchObject({ attempts: 1, publishedAt: null, lastError: "The in-memory publisher was told to fail" });
    expect(rows[1]).toMatchObject({ attempts: 0, publishedAt: null });

    const second = await relay.runOnce();

    expect(second).toEqual({ published: 3, failed: false });
    expect(publisher.published.map((m) => (m.event.data as { closedBy: string }).closedBy)).toEqual(["event-1", "event-2", "event-3"]);
  });

  it("keeps the already published rows when a later one fails", async () => {
    const { relay, publisher, store } = await coreWithEvents(3);
    const publish = publisher.publish.bind(publisher);
    let calls = 0;
    publisher.publish = (...args) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("broker down"));
      return publish(...args);
    };

    expect(await relay.runOnce()).toEqual({ published: 1, failed: true });
    const rows = store.snapshot().outbox;
    expect(rows.map((r) => r.publishedAt !== null)).toEqual([true, false, false]);
    expect(rows[1]).toMatchObject({ attempts: 1, lastError: "broker down" });
  });

  it("claims at most one batch per poll", async () => {
    const core = await coreWithEvents(5);
    const relay = new OutboxRelay({ store: core.store, publisher: core.publisher, clock: core.clock, logger: core.logger, pollMs: 5, batchSize: 2, streamMaxAgeMs: STREAM_MAX_AGE_MS });
    expect(await relay.runOnce()).toEqual({ published: 2, failed: false });
    expect(core.publisher.published).toHaveLength(2);
  });

  it("polls in the background, recovers from a failure and stops cleanly", async () => {
    const { relay, publisher, store, addEvent } = await coreWithEvents(2);
    publisher.failNext = 2;

    relay.start();
    relay.start(); // a second start changes nothing
    await waitFor(() => publisher.published.length === 2);
    await relay.stop();
    expect(store.snapshot().outbox.every((row) => row.publishedAt !== null)).toBe(true);

    // Stopped: an event written now stays in the outbox.
    await addEvent("late");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(publisher.published).toHaveLength(2);
    expect(store.snapshot().outbox.filter((row) => row.publishedAt === null)).toHaveLength(1);
  });

  it("keeps running when the outbox cannot be read", async () => {
    const { relay, store, logger } = await coreWithEvents(1);
    let failures = 2;
    const transaction = store.transaction.bind(store);
    store.transaction = ((work: Parameters<typeof transaction>[0]) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("database is down"));
      }
      return transaction(work);
    }) as typeof store.transaction;

    relay.start();
    await waitFor(() => store.snapshot().outbox.every((row) => row.publishedAt !== null));
    await relay.stop();

    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
  });
});

describe("OutboxRelay purging", () => {
  it("keeps published rows for the max age of the stream (here 7 days), and deletes them after that", async () => {
    const { relay, store, clock } = await coreWithEvents(1);
    await relay.runOnce();

    clock.advanceMs(7 * DAY_MS);
    expect(await relay.purgeIfDue()).toBe(0);
    expect(labelsOf(store)).toEqual(["event-1"]);

    clock.advanceMs(3_600_000 + 1); // an hour later, and the row is now older than 7 days
    expect(await relay.purgeIfDue()).toBe(1);
    expect(labelsOf(store)).toEqual([]);
  });

  it("deletes only rows published more than 7 days ago, never an unpublished one however old", async () => {
    const { relay, store, clock, addEvent } = await coreWithEvents(2);
    await relay.runOnce(); // event-1 and event-2, published on day 0
    clock.advanceMs(5 * DAY_MS);
    await addEvent("event-3");
    await relay.runOnce(); // published on day 5
    await addEvent("stuck-4"); // written on day 5, the relay does not run again
    clock.advanceMs(3 * DAY_MS); // day 8

    expect(await relay.purgeIfDue()).toBe(2);
    expect(labelsOf(store)).toEqual(["event-3", "stuck-4"]);

    clock.advanceMs(30 * DAY_MS);
    expect(await relay.purgeIfDue()).toBe(1);
    expect(labelsOf(store)).toEqual(["stuck-4"]);
    expect(store.snapshot().outbox[0]).toMatchObject({ publishedAt: null });
  });

  it("deletes at most once an hour, and the first call always runs", async () => {
    const core = await coreWithEvents(1);
    const relay = new OutboxRelay({ store: core.store, publisher: core.publisher, clock: core.clock, logger: core.logger, pollMs: 5, streamMaxAgeMs: 1000 });
    await relay.runOnce();
    core.clock.advanceMs(5000);

    expect(await relay.purgeIfDue()).toBe(1);

    await core.addEvent("event-2");
    await relay.runOnce();
    core.clock.advanceMs(5000);
    expect(await relay.purgeIfDue()).toBe(0); // the row is old enough, but the last purge was 5 seconds ago
    expect(labelsOf(core.store)).toEqual(["event-2"]);
    core.clock.advanceMs(3_600_000 - 5000);
    expect(await relay.purgeIfDue()).toBe(1);
    expect(labelsOf(core.store)).toEqual([]);
  });

  it("deletes inbox entries on the same timer, after the stream's max age (here 7 days) and a day of margin (DM-06)", async () => {
    const { relay, store, clock, logger } = await coreWithEvents(0);
    expect(inboxRetentionFor(STREAM_MAX_AGE_MS)).toBe(8 * DAY_MS);
    const entry = (eventId: string) => ({ consumer: "tenant-created", eventId, eventType: "si.chance.tenants.TenantCreated.v1", processedAt: clock.now() });
    await store.transaction((repositories) => repositories.inbox.record(entry("old")));
    clock.advanceMs(6 * DAY_MS);
    await store.transaction((repositories) => repositories.inbox.record(entry("newer")));
    clock.advanceMs(2 * DAY_MS + 1); // "old" is 8 days and 1 ms old, "newer" 2 days

    await relay.purgeIfDue();

    expect(store.snapshot().inbox.map((row) => row.eventId)).toEqual(["newer"]);
    expect(logger.lines.some((line) => line.message === "Deleted old entries of the inbox")).toBe(true);
    // A redelivery of the purged event would be processed again: that is why the retention exceeds the stream's.
    expect(await store.transaction((repositories) => repositories.inbox.record(entry("old")))).toBe(true);
  });

  it("is done by the polling loop, and a failing purge neither stops the loop nor loses events", async () => {
    const { relay, store, clock, publisher, logger, addEvent } = await coreWithEvents(1);
    await relay.runOnce();
    clock.advanceMs(8 * DAY_MS);
    const purge = store.repositories.outbox.purgePublished.bind(store.repositories.outbox);
    let failures = 1;
    store.repositories.outbox.purgePublished = (olderThan) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("database is down"));
      }
      return purge(olderThan);
    };

    relay.start();
    await waitFor(() => logger.lines.some((line) => line.level === "warn" && String(line.message).includes("could not delete")));
    await addEvent("event-2");
    await waitFor(() => publisher.published.length === 2);
    clock.advanceMs(3_600_000 + 1);
    await waitFor(() => !labelsOf(store).includes("event-1"));
    await relay.stop();

    expect(labelsOf(store)).toEqual(["event-2"]);
  });
});

describe("OutboxRelay with the default max age of 30 days (STREAM_MAX_AGE_DAYS)", () => {
  const maxAgeMs = streamMaxAgeMs(DEFAULT_STREAM_MAX_AGE_DAYS);

  it("keeps published rows for the configured max age, not for a fixed 7 days", async () => {
    const { relay, store, clock } = await coreWithEvents(1, maxAgeMs);
    await relay.runOnce();

    clock.advanceMs(8 * DAY_MS);
    expect(await relay.purgeIfDue()).toBe(0);
    clock.advanceMs(22 * DAY_MS); // 30 days after the publish: still kept
    expect(await relay.purgeIfDue()).toBe(0);
    expect(labelsOf(store)).toEqual(["event-1"]);

    clock.advanceMs(3_600_000 + 1); // and now it is older than 30 days
    expect(await relay.purgeIfDue()).toBe(1);
    expect(labelsOf(store)).toEqual([]);
  });

  it("keeps an inbox entry a day longer than the stream keeps its messages", async () => {
    const { relay, store, clock } = await coreWithEvents(0, maxAgeMs);
    await store.transaction((repositories) => repositories.inbox.record({ consumer: "tenant-created", eventId: "e1", eventType: "si.chance.tenants.TenantCreated.v1", processedAt: clock.now() }));

    clock.advanceMs(30 * DAY_MS + 1);
    await relay.purgeIfDue();
    expect(store.snapshot().inbox).toHaveLength(1);

    clock.advanceMs(DAY_MS); // 31 days and 1 ms old
    await relay.purgeIfDue();
    expect(store.snapshot().inbox).toHaveLength(0);
  });
});
