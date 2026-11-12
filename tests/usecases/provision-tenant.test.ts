import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import type { SharedRepositories, Store } from "../../src/usecases/ports.js";
import { TENANT_CREATED_CONSUMER } from "../../src/usecases/support.js";
import { RecordingLogger, TENANT_A, TENANT_B, TestClock } from "../support/fakes.js";
import { createCore, createOpenMarket, tenantAdmin } from "./core.js";

const notice = (eventId: string, tenantId = TENANT_A) => ({
  eventId,
  eventType: "si.chance.tenants.TenantCreated.v1",
  tenantId,
  correlationId: "corr-1" as string | null,
});

function setup(store: Store = new MemoryStore()) {
  const clock = new TestClock();
  const logger = new RecordingLogger();
  return { clock, logger, store, provision: new ProvisionTenant({ store, clock, logger }) };
}

describe("ProvisionTenant", () => {
  it("registers the tenant and records the event in the inbox in one commit", async () => {
    const memory = new MemoryStore();
    const { provision, clock, logger } = setup(memory);
    expect(await memory.forTenant(TENANT_A)).toBeNull();

    const result = await provision.execute(notice("event-1"));

    expect(result).toBe("provisioned");
    const state = memory.snapshot();
    expect(state.tenants).toEqual([TENANT_A]);
    expect(state.inbox).toEqual([{ consumer: TENANT_CREATED_CONSUMER, eventId: "event-1", eventType: "si.chance.tenants.TenantCreated.v1", processedAt: clock.now() }]);
    expect(await memory.forTenant(TENANT_A)).not.toBeNull();
    expect(logger.lines).toEqual([expect.objectContaining({ level: "info", fields: { tenantId: TENANT_A, eventId: "event-1", correlationId: "corr-1" } })]);
  });

  it("changes nothing for a redelivered event (duplicate), and is idempotent for another event of the same tenant", async () => {
    const memory = new MemoryStore();
    const { provision } = setup(memory);
    await provision.execute(notice("event-1"));
    const before = memory.snapshot();

    expect(await provision.execute(notice("event-1"))).toBe("duplicate");
    expect(memory.snapshot()).toEqual(before);

    expect(await provision.execute(notice("event-2"))).toBe("provisioned");
    const state = memory.snapshot();
    expect(state.tenants).toEqual([TENANT_A]);
    expect(state.inbox.map((entry) => entry.eventId)).toEqual(["event-1", "event-2"]);
  });

  it("provisions two tenants independently", async () => {
    const memory = new MemoryStore();
    const { provision } = setup(memory);

    await provision.execute(notice("event-a", TENANT_A));
    await provision.execute(notice("event-b", TENANT_B));

    expect(memory.snapshot().tenants).toEqual([TENANT_A, TENANT_B]);
  });

  it("makes the tenant usable: after it, the use cases of that tenant stop answering 503", async () => {
    const core = await createCore({ provision: false });
    await expect(core.useCases.listMarkets.execute({ actor: tenantAdmin() })).rejects.toMatchObject({ code: "tenant_not_ready" });

    await core.useCases.provisionTenant.execute(notice("event-1"));

    await expect(core.useCases.listMarkets.execute({ actor: tenantAdmin() })).resolves.toEqual({ items: [], nextCursor: null });
    expect((await createOpenMarket(core)).status).toBe("open");
  });

  it("rolls back the inbox entry when the provisioning fails, so the redelivery provisions the tenant", async () => {
    const memory = new MemoryStore();
    let failing = true;
    const store: Store = {
      repositories: memory.repositories,
      forTenant: (tenantId) => memory.forTenant(tenantId),
      ping: () => memory.ping(),
      transaction: (work) =>
        memory.transaction((repositories: SharedRepositories) =>
          work({
            ...repositories,
            tenants: {
              ...repositories.tenants,
              provision: (tenantId, now) => (failing ? Promise.reject(new Error("migration failed")) : repositories.tenants.provision(tenantId, now)),
            },
          }),
        ),
    };
    const { provision } = setup(store);

    await expect(provision.execute(notice("event-1"))).rejects.toThrow("migration failed");
    expect(memory.snapshot()).toMatchObject({ tenants: [], inbox: [] });

    failing = false;
    await expect(provision.execute(notice("event-1"))).resolves.toBe("provisioned");
    expect(memory.snapshot().tenants).toEqual([TENANT_A]);
  });

  it("logs a duplicate as such", async () => {
    const { provision, logger } = setup();
    await provision.execute(notice("event-1"));

    await provision.execute(notice("event-1"));

    expect(logger.messages("info")).toEqual(["Tenant provisioned", "TenantCreated was processed before; nothing changed"]);
  });
});
