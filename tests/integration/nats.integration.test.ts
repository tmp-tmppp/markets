import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NatsEventPublisher, STREAM_NAME } from "../../src/adapters/nats/nats-event-publisher.js";
import { CONSUMER_NAME, TENANTS_STREAM, TENANT_CREATED_FILTER, TenantCreatedConsumer } from "../../src/adapters/nats/tenant-created-consumer.js";
import { streamMaxAgeMs } from "../../src/adapters/retention.js";
import { EVENT_SOURCE, eventType, marketSubject, natsSubject } from "../../src/domain/events.js";
import type { CloudEvent } from "../../src/domain/events.js";
import { TENANT_CREATED_TYPE } from "../../src/domain/tenant.js";
import type { TenantCreatedNotice } from "../../src/domain/tenant.js";
import type { ProvisionTenantResult, ProvisionTenantUseCase } from "../../src/usecases/use-cases.js";
import { RecordingLogger, TENANT_A, TENANT_B } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They run against a real NATS server with
// JetStream, because the stream and consumer calls of the broker are what the adapters in src/adapters/nats consist of.

let container: StartedTestContainer;
let url: string;
let nc: NatsConnection;
let jsm: JetStreamManager;
let js: JetStreamClient;

beforeAll(async () => {
  container = await new GenericContainer("nats:2.15.2-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  url = `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`;
  nc = await connect({ servers: url });
  jsm = await jetstreamManager(nc);
  js = jetstream(nc);
}, 180_000);

afterAll(async () => {
  await nc?.drain().catch(() => undefined);
  await container?.stop();
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isStreamMissing = (error: unknown): boolean => error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

async function deleteStream(name: string): Promise<void> {
  try {
    await jsm.streams.delete(name);
  } catch (error) {
    if (!isStreamMissing(error)) throw error;
  }
}

// Not the default of 30 days, so that the tests show that the configured value is the one that reaches the stream.
const MAX_AGE_MS = streamMaxAgeMs(45);

describe("NatsEventPublisher", () => {
  let publisher: NatsEventPublisher;
  const logger = new RecordingLogger();

  beforeEach(async () => {
    await deleteStream(STREAM_NAME);
    publisher = new NatsEventPublisher(url, logger, MAX_AGE_MS);
  });
  afterEach(async () => {
    await publisher.close();
  });

  const closed = (id: string): CloudEvent<unknown> => ({
    specversion: "1.0",
    id,
    source: EVENT_SOURCE,
    type: eventType("MarketClosed"),
    subject: marketSubject("00000000-0000-7000-8000-000000000001"),
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    causationid: "req-1",
    data: { marketId: "00000000-0000-7000-8000-000000000001", version: 4, closedAt: "2026-11-01T10:00:00.000Z", closedBy: "admin-1" },
  });

  it("creates the MARKETS stream on the first publish: subjects chance.markets.>, file storage, the configured max age", async () => {
    await publisher.publish(natsSubject("MarketClosed", TENANT_A), closed("018f3c1e-7a00-7000-8000-000000000a01"), "018f3c1e-7a00-7000-8000-000000000a01");

    const { config } = await jsm.streams.info(STREAM_NAME);
    expect(STREAM_NAME).toBe("MARKETS");
    expect(config.subjects).toEqual(["chance.markets.>"]);
    expect(config.storage).toBe("file");
    expect(config.max_age).toBe(nanos(MAX_AGE_MS));
  });

  it("publishes the CloudEvent as JSON on the subject, with the event id as Nats-Msg-Id, and a repeat of the id stores nothing new", async () => {
    const id = "018f3c1e-7a00-7000-8000-000000000a02";
    const event = closed(id);
    await publisher.publish(natsSubject("MarketClosed", TENANT_A), event, id);
    await publisher.publish(natsSubject("MarketClosed", TENANT_A), event, id);
    await publisher.publish(natsSubject("MarketClosed", TENANT_B), closed("018f3c1e-7a00-7000-8000-000000000a03"), "018f3c1e-7a00-7000-8000-000000000a03");

    const info = await jsm.streams.info(STREAM_NAME);
    expect(info.state.messages).toBe(2);
    const consumer = await js.consumers.get(STREAM_NAME);
    const message = await consumer.next({ expires: 3000 });
    expect(message?.subject).toBe(`chance.markets.MarketClosed.${TENANT_A}`);
    expect(message?.headers?.get("Nats-Msg-Id")).toBe(id);
    expect(message?.json()).toEqual(event);
  });

  it("updates the stream it finds instead of failing, and reconnects after close()", async () => {
    await jsm.streams.add({ name: STREAM_NAME, subjects: ["chance.markets.>"], max_age: nanos(1000) });

    await publisher.publish(natsSubject("MarketClosed", TENANT_A), closed("018f3c1e-7a00-7000-8000-000000000a04"), "018f3c1e-7a00-7000-8000-000000000a04");
    expect((await jsm.streams.info(STREAM_NAME)).config.max_age).toBe(nanos(MAX_AGE_MS));

    await publisher.close();
    await publisher.publish(natsSubject("MarketClosed", TENANT_A), closed("018f3c1e-7a00-7000-8000-000000000a05"), "018f3c1e-7a00-7000-8000-000000000a05");
    expect((await jsm.streams.info(STREAM_NAME)).state.messages).toBe(2);
  });

  it("brings the existing stream to the configured max age at every start, up to the longest setting and down again", async () => {
    for (const [index, days] of [365, 7, 30].entries()) {
      const maxAgeMs = streamMaxAgeMs(days);
      const restarted = new NatsEventPublisher(url, logger, maxAgeMs);
      const id = `018f3c1e-7a00-7000-8000-00000000b00${String(index)}`;
      await restarted.publish(natsSubject("MarketClosed", TENANT_A), closed(id), id);

      expect((await jsm.streams.info(STREAM_NAME)).config.max_age, `${String(days)} days`).toBe(nanos(maxAgeMs));
      await restarted.close();
    }
  });

  it("rejects a publish while the broker is unreachable, so the relay keeps the row in the outbox", async () => {
    const unreachable = new NatsEventPublisher("nats://127.0.0.1:1", logger, MAX_AGE_MS);

    await expect(unreachable.publish(natsSubject("MarketClosed", TENANT_A), closed("018f3c1e-7a00-7000-8000-000000000a06"), "018f3c1e-7a00-7000-8000-000000000a06")).rejects.toThrow();
  });
});

/** Records what the consumer hands to the use case; the first `failures` calls throw, like a database that is down. */
class RecordingProvision implements ProvisionTenantUseCase {
  readonly notices: TenantCreatedNotice[] = [];
  failures = 0;

  execute(notice: TenantCreatedNotice): Promise<ProvisionTenantResult> {
    this.notices.push(notice);
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error("database is down"));
    }
    return Promise.resolve("provisioned");
  }
}

describe("TenantCreatedConsumer", () => {
  let provision: RecordingProvision;
  let logger: RecordingLogger;
  let consumers: TenantCreatedConsumer[];

  const eventId = (n: number): string => `018f3c1e-7a00-7000-8000-${String(n).padStart(12, "0")}`;
  const tenantCreated = (n: number, tenantId = TENANT_A): Record<string, unknown> => ({
    specversion: "1.0",
    id: eventId(n),
    source: "/chance/tenants",
    type: TENANT_CREATED_TYPE,
    subject: `tenant/${tenantId}`,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: `corr-${String(n)}`,
    causationid: "req-1",
    data: { tenantId, slug: `tenant-${String(n)}` },
  });
  const publish = (subject: string, body: unknown): Promise<unknown> => js.publish(subject, new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));
  const publishCreated = (n: number, tenantId = TENANT_A) => publish(`chance.tenants.TenantCreated.${tenantId}`, tenantCreated(n, tenantId));
  const createTenantsStream = () => jsm.streams.add({ name: TENANTS_STREAM, subjects: ["chance.tenants.>"] });
  const startConsumer = (options: Partial<ConstructorParameters<typeof TenantCreatedConsumer>[0]> = {}): TenantCreatedConsumer => {
    const consumer = new TenantCreatedConsumer({ url, provision, logger, nakDelayMs: 50, reconnectDelayMs: 50, ...options });
    consumers.push(consumer);
    consumer.start();
    return consumer;
  };
  const info = () => jsm.consumers.info(TENANTS_STREAM, CONSUMER_NAME);
  const settled = async (): Promise<boolean> => {
    const current = await info();
    return current.num_ack_pending === 0 && current.num_pending === 0;
  };

  beforeEach(async () => {
    await deleteStream(TENANTS_STREAM);
    provision = new RecordingProvision();
    logger = new RecordingLogger();
    consumers = [];
  });
  afterEach(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });

  it("uses the names of the convention: stream TENANTS, durable consumer markets, filter chance.tenants.TenantCreated.*", () => {
    expect([TENANTS_STREAM, CONSUMER_NAME, TENANT_CREATED_FILTER]).toEqual(["TENANTS", "markets", "chance.tenants.TenantCreated.*"]);
  });

  it("creates the durable pull consumer: explicit acks, deliver all, the filter, ack wait 30 s, a small max ack pending", async () => {
    await createTenantsStream();

    startConsumer();
    await waitFor(async () => (await jsm.consumers.info(TENANTS_STREAM, CONSUMER_NAME).catch(() => null)) !== null);

    const { config } = await info();
    expect(config).toMatchObject({
      durable_name: CONSUMER_NAME,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: TENANT_CREATED_FILTER,
      ack_wait: nanos(30_000),
      max_ack_pending: 10,
    });
  });

  it("brings a consumer that exists with another configuration to this one", async () => {
    await createTenantsStream();
    await jsm.consumers.add(TENANTS_STREAM, {
      durable_name: CONSUMER_NAME,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: TENANT_CREATED_FILTER,
      ack_wait: nanos(5000),
      max_ack_pending: 100,
    });

    startConsumer({ ackWaitMs: 20_000, maxAckPending: 4 });
    await waitFor(async () => (await info()).config.max_ack_pending === 4);

    expect((await info()).config).toMatchObject({ ack_wait: nanos(20_000), max_ack_pending: 4, filter_subject: TENANT_CREATED_FILTER });
  });

  it("handles TenantCreated events in order, from the first message of the stream, and acknowledges after the handler", async () => {
    await createTenantsStream();
    await publishCreated(1);
    await publishCreated(2, TENANT_B);

    startConsumer();
    await waitFor(() => provision.notices.length === 2);
    await waitFor(settled);

    expect(provision.notices).toEqual([
      { eventId: eventId(1), eventType: TENANT_CREATED_TYPE, tenantId: TENANT_A, correlationId: "corr-1" },
      { eventId: eventId(2), eventType: TENANT_CREATED_TYPE, tenantId: TENANT_B, correlationId: "corr-2" },
    ]);
    expect((await info()).ack_floor.stream_seq).toBe(2);
  });

  it("does not deliver other events of the stream", async () => {
    await createTenantsStream();
    await publish(`chance.tenants.TenantSuspended.${TENANT_A}`, { type: "si.chance.tenants.TenantSuspended.v1" });
    await publishCreated(3);

    startConsumer();
    await waitFor(() => provision.notices.length === 1);
    await waitFor(settled);

    expect(provision.notices.map((notice) => notice.eventId)).toEqual([eventId(3)]);
    expect((await info()).delivered.stream_seq).toBe(2);
  });

  it("asks the broker to deliver again after a transient error, and acknowledges when it works", async () => {
    await createTenantsStream();
    provision.failures = 2;
    await publishCreated(4);

    startConsumer();
    await waitFor(() => provision.notices.length === 3);
    await waitFor(settled);

    expect(provision.notices.map((notice) => notice.eventId)).toEqual([eventId(4), eventId(4), eventId(4)]);
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
  });

  it("acknowledges a poison message at once: it is neither handled nor delivered again, and the next event still arrives", async () => {
    await createTenantsStream();
    await publish(`chance.tenants.TenantCreated.${TENANT_A}`, "{this is not json");
    await publish(`chance.tenants.TenantCreated.${TENANT_A}`, { specversion: "1.0", id: eventId(5), type: "si.chance.tenants.TenantCreated.v9" });
    await publishCreated(6);

    startConsumer();
    await waitFor(() => provision.notices.length === 1);
    await waitFor(settled);

    expect(provision.notices.map((notice) => notice.eventId)).toEqual([eventId(6)]);
    expect(logger.lines.filter((line) => line.level === "warn" && String(line.message).includes("skipped"))).toHaveLength(2);
    expect((await info()).ack_floor.stream_seq).toBe(3);
  });

  it("remembers its position across a restart: acknowledged events are not handled again", async () => {
    await createTenantsStream();
    await publishCreated(7);
    const first = startConsumer();
    await waitFor(() => provision.notices.length === 1);
    await waitFor(settled);
    await first.stop();

    await publishCreated(8, TENANT_B);
    startConsumer();
    await waitFor(() => provision.notices.length === 2);
    await waitFor(settled);

    expect(provision.notices.map((notice) => notice.eventId)).toEqual([eventId(7), eventId(8)]);
  });

  it("starts without the TENANTS stream, says so, and picks the events up when the stream appears", async () => {
    startConsumer();
    await waitFor(() => logger.messages("warn").includes("The TENANTS stream does not exist yet; trying again"));
    expect(provision.notices).toEqual([]);

    await createTenantsStream();
    await publishCreated(9);
    await waitFor(() => provision.notices.length === 1);

    expect(provision.notices[0]?.eventId).toBe(eventId(9));
  });

  it("goes on consuming after the TENANTS stream was deleted and created again while the service runs", async () => {
    await createTenantsStream();
    await publishCreated(10);
    startConsumer();
    await waitFor(() => provision.notices.length === 1);
    await waitFor(settled);

    // The tenants service (or an operator) deletes the stream and creates it again: the durable consumer is gone with it.
    await jsm.streams.delete(TENANTS_STREAM);
    await createTenantsStream();
    await publishCreated(11, TENANT_B);

    await waitFor(() => provision.notices.length === 2);
    expect(provision.notices.map((notice) => notice.eventId)).toEqual([eventId(10), eventId(11)]);
  });

  it("stops quickly when it has nothing to do", async () => {
    await createTenantsStream();
    const consumer = startConsumer();
    await waitFor(async () => (await jsm.consumers.info(TENANTS_STREAM, CONSUMER_NAME).catch(() => null)) !== null);

    const started = Date.now();
    await consumer.stop();

    expect(Date.now() - started).toBeLessThan(5000);
  });
});
