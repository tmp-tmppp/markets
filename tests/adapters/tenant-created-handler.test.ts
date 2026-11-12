import { describe, expect, it } from "vitest";
import { handleTenantCreatedMessage } from "../../src/adapters/nats/tenant-created-handler.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { TENANT_CREATED_TYPE } from "../../src/domain/tenant.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import type { ProvisionTenantUseCase } from "../../src/usecases/use-cases.js";
import { RecordingLogger, TENANT_A, TENANT_B, TestClock } from "../support/fakes.js";

const EVENT_1 = "018f3c1e-7a00-7000-8000-000000000e01";
const EVENT_2 = "018f3c1e-7a00-7000-8000-000000000e02";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

/** A TenantCreated CloudEvent as the tenants service publishes it; fields can be overridden or removed (undefined). */
function tenantCreated(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    specversion: "1.0",
    id: EVENT_1,
    source: "/chance/tenants",
    type: TENANT_CREATED_TYPE,
    subject: `tenant/${TENANT_A}`,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    causationid: "req-1",
    data: { tenantId: TENANT_A, slug: "acme" },
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete event[key];
  return event;
}

function setup() {
  const store = new MemoryStore();
  const clock = new TestClock();
  const logger = new RecordingLogger();
  const provision = new ProvisionTenant({ store, clock, logger });
  return { store, clock, logger, provision };
}

describe("handleTenantCreatedMessage", () => {
  it("provisions the tenant, records the event in the inbox and acknowledges", async () => {
    const { store, provision, logger } = setup();

    expect(await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger)).toBe("ack");

    const snapshot = store.snapshot();
    expect(snapshot.tenants).toEqual([TENANT_A]);
    expect(snapshot.inbox).toEqual([expect.objectContaining({ consumer: "tenant-created", eventId: EVENT_1, eventType: TENANT_CREATED_TYPE })]);
    expect(logger.lines.some((line) => line.level === "info" && (line.fields as { result?: string }).result === "provisioned")).toBe(true);
  });

  it("takes the tenant from the tenantid attribute in lower case", async () => {
    const { store, provision, logger } = setup();

    await handleTenantCreatedMessage(encode(tenantCreated({ tenantid: TENANT_A.toUpperCase(), data: {} })), provision, logger);

    expect(store.snapshot().tenants).toEqual([TENANT_A]);
  });

  it("acknowledges a redelivered event and changes nothing (duplicate)", async () => {
    const { store, provision, logger } = setup();
    await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger);
    const before = store.snapshot();

    expect(await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger)).toBe("ack");

    expect(store.snapshot()).toEqual(before);
    expect(logger.lines.some((line) => (line.fields as { result?: string }).result === "duplicate")).toBe(true);
  });

  it("handles two different events for two tenants", async () => {
    const { store, provision, logger } = setup();

    await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger);
    await handleTenantCreatedMessage(encode(tenantCreated({ id: EVENT_2, tenantid: TENANT_B, data: { tenantId: TENANT_B } })), provision, logger);

    expect(store.snapshot().tenants).toEqual([TENANT_A, TENANT_B]);
    expect(store.snapshot().inbox.map((entry) => entry.eventId)).toEqual([EVENT_1, EVENT_2]);
  });

  it.each([
    ["is not JSON", "{not json"],
    ["is a JSON array", "[1, 2]"],
    ["is JSON null", "null"],
    ["is not a CloudEvent 1.0", tenantCreated({ specversion: "0.3" })],
    ["is of another type", tenantCreated({ type: "si.chance.tenants.TenantSuspended.v1" })],
    ["has a newer version of the type", tenantCreated({ type: "si.chance.tenants.TenantCreated.v2" })],
    ["has no id", tenantCreated({ id: undefined })],
    ["has an id that is not a UUID", tenantCreated({ id: "event-1" })],
    ["has no tenantid", tenantCreated({ tenantid: undefined })],
    ["has a tenantid that is not a UUID", tenantCreated({ tenantid: "acme" })],
    ["has a data.tenantId that differs from tenantid", tenantCreated({ data: { tenantId: TENANT_B } })],
  ])("warns and acknowledges a message that %s, so a poison message cannot block the consumer", async (_name, body) => {
    const { store, provision, logger } = setup();

    expect(await handleTenantCreatedMessage(encode(body), provision, logger)).toBe("ack");

    expect(store.snapshot()).toEqual({ tenants: [], tenantNames: {}, markets: [], outbox: [], inbox: [], pendingOpenings: [], shareLinks: [] });
    expect(logger.lines.filter((line) => line.level === "warn")).toHaveLength(1);
    expect(logger.lines.some((line) => line.level === "error")).toBe(false);
  });

  it("acknowledges an empty message", async () => {
    const { provision, logger } = setup();
    expect(await handleTenantCreatedMessage(new Uint8Array(), provision, logger)).toBe("ack");
    expect(logger.messages("warn")).toHaveLength(1);
  });

  it("asks for a new delivery when the use case fails, logs the error with the ids and keeps nothing", async () => {
    const { store, provision, logger } = setup();
    const failing: ProvisionTenantUseCase = { execute: () => Promise.reject(new Error("database is down")) };

    expect(await handleTenantCreatedMessage(encode(tenantCreated()), failing, logger)).toBe("nak");

    const errors = logger.lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ tenantId: TENANT_A, eventId: EVENT_1, correlationId: "corr-1" });
    expect(store.snapshot().inbox).toEqual([]);

    // The broker delivers it again, the database is back, and the event is processed.
    expect(await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger)).toBe("ack");
    expect(store.snapshot().tenants).toEqual([TENANT_A]);
  });

  it("does not leave an inbox entry behind when provisioning fails inside the transaction", async () => {
    const { store, logger, clock } = setup();
    const provision = new ProvisionTenant({ store, clock, logger });
    const real = store.transaction.bind(store);
    store.transaction = ((work: Parameters<typeof real>[0]) =>
      real((repositories) => {
        repositories.tenants.provision = () => Promise.reject(new Error("a migration failed"));
        return work(repositories);
      })) as typeof store.transaction;

    expect(await handleTenantCreatedMessage(encode(tenantCreated()), provision, logger)).toBe("nak");

    expect(store.snapshot().inbox).toEqual([]);
    expect(store.snapshot().tenants).toEqual([]);
  });
});
