import { describe, expect, it } from "vitest";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import type { CloudEvent } from "../../src/domain/events.js";
import { RecordingLogger, TENANT_A } from "../support/fakes.js";

const event: CloudEvent<unknown> = {
  specversion: "1.0",
  id: "event-1",
  source: "/chance/markets",
  type: "si.chance.markets.MarketClosed.v1",
  subject: "market/m-1",
  time: "2026-11-01T10:00:00.000Z",
  datacontenttype: "application/json",
  tenantid: TENANT_A,
  correlationid: "c",
  causationid: "k",
  data: {},
};

describe("MemoryEventPublisher", () => {
  it("collects what it is given, in order, and logs each event when it has a logger", async () => {
    const logger = new RecordingLogger();
    const publisher = new MemoryEventPublisher(logger);

    await publisher.publish(`chance.markets.MarketClosed.${TENANT_A}`, event, "event-1");
    await publisher.publish(`chance.markets.MarketClosed.${TENANT_A}`, { ...event, id: "event-2" }, "event-2");

    expect(publisher.published.map((message) => message.messageId)).toEqual(["event-1", "event-2"]);
    expect(publisher.published[0]).toEqual({ subject: `chance.markets.MarketClosed.${TENANT_A}`, event, messageId: "event-1" });
    expect(logger.lines).toHaveLength(2);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { eventId: "event-1", type: event.type } });
  });

  it("fails the next calls it was told to fail, then works again", async () => {
    const publisher = new MemoryEventPublisher();
    publisher.failNext = 2;

    await expect(publisher.publish("s", event, "event-1")).rejects.toThrow("told to fail");
    await expect(publisher.publish("s", event, "event-1")).rejects.toThrow("told to fail");
    await expect(publisher.publish("s", event, "event-1")).resolves.toBeUndefined();

    expect(publisher.published).toHaveLength(1);
  });
});
