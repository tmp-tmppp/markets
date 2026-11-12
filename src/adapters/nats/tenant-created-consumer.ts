import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { ConsumerMessages, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import type { Logger } from "../../usecases/ports.js";
import type { ProvisionTenantUseCase } from "../../usecases/use-cases.js";
import { handleTenantCreatedMessage } from "./tenant-created-handler.js";

export const TENANTS_STREAM = "TENANTS";
/** The durable name: the broker remembers the position of this consumer under it, across restarts. */
export const CONSUMER_NAME = "markets";
export const TENANT_CREATED_FILTER = "chance.tenants.TenantCreated.*";

export interface TenantCreatedConsumerOptions {
  url: string;
  provision: ProvisionTenantUseCase;
  logger: Logger;
  /** How long the broker waits for an acknowledgement before it delivers a message again. Default 30 s. */
  ackWaitMs?: number;
  /** Messages delivered but not yet acknowledged; small, because the messages are handled one at a time. Default 10. */
  maxAckPending?: number;
  /** Delay of the next delivery after a transient error. Default 5 s. */
  nakDelayMs?: number;
  /** Wait before the consumer connects again after a failure, or while the TENANTS stream does not exist yet. Default 5 s. */
  reconnectDelayMs?: number;
}

const isConsumerMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.ConsumerNotFound;

const isStreamMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

/**
 * The first consumer in the system, so it sets the convention (ADR-053): a durable pull consumer "markets" on the TENANTS
 * stream, filtered to TenantCreated, explicit acknowledgements, delivery from the first message (a TenantCreated from
 * before markets existed is not missed, as long as the stream still keeps it: 30 days by default). The consumer is created, or
 * brought to this configuration, on every connect, as the publisher does for its stream.
 *
 * The service starts and serves without it: a missing TENANTS stream (tenants may start later), a refused connection or
 * a failed consumer is logged and tried again after `reconnectDelayMs`. Messages are handled one at a time, in order;
 * a message is acknowledged only after handleTenantCreatedMessage returned "ack", which is after the transaction of the
 * use case committed. "nak" asks for a new delivery after `nakDelayMs`. stop() finishes the message in hand.
 */
export class TenantCreatedConsumer {
  private nc: NatsConnection | null = null;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private active: ConsumerMessages | null = null;
  private wake: (() => void) | null = null;
  private readonly ackWaitMs: number;
  private readonly maxAckPending: number;
  private readonly nakDelayMs: number;
  private readonly reconnectDelayMs: number;

  constructor(private readonly options: TenantCreatedConsumerOptions) {
    this.ackWaitMs = options.ackWaitMs ?? 30_000;
    this.maxAckPending = options.maxAckPending ?? 10;
    this.nakDelayMs = options.nakDelayMs ?? 5000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
  }

  /** Starts the loop; returns at once and never throws. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Stops the loop, waits for the message in progress and closes the connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    this.active?.stop();
    await this.loop;
    this.loop = null;
    const nc = this.nc;
    this.nc = null;
    if (nc && !nc.isClosed()) await nc.drain().catch(() => undefined);
  }

  private async ensureConsumer(manager: JetStreamManager): Promise<void> {
    const settings = { ack_wait: nanos(this.ackWaitMs), max_ack_pending: this.maxAckPending, max_deliver: -1, filter_subject: TENANT_CREATED_FILTER };
    try {
      await manager.consumers.info(TENANTS_STREAM, CONSUMER_NAME);
    } catch (error) {
      // A missing stream also throws here and is left to the loop, which logs it and tries again.
      if (!isConsumerMissing(error)) throw error;
      await manager.consumers.add(TENANTS_STREAM, {
        durable_name: CONSUMER_NAME,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ...settings,
      });
      return;
    }
    await manager.consumers.update(TENANTS_STREAM, CONSUMER_NAME, settings);
  }

  private async run(): Promise<void> {
    const { url, provision, logger } = this.options;
    let failures = 0;
    while (!this.stopping) {
      try {
        const nc = this.nc && !this.nc.isClosed() ? this.nc : await connect({ servers: url, name: "markets-consumer", maxReconnectAttempts: -1 });
        this.nc = nc;
        await this.ensureConsumer(await jetstreamManager(nc));
        const consumer = await jetstream(nc).consumers.get(TENANTS_STREAM, CONSUMER_NAME);
        // abort_on_missing_resource: when the TENANTS stream or this durable consumer is deleted while the loop runs (the
        // tenants service creating its stream again, an operator, lost broker storage), the iterator throws instead of
        // waiting forever for a consumer nobody creates; the catch below logs it and the next round creates it again.
        const messages = await consumer.consume({ max_messages: this.maxAckPending, abort_on_missing_resource: true });
        this.active = messages;
        // stop() may have been called while the consumer was being set up: it saw no active messages then.
        if (this.stopping) messages.stop();
        failures = 0;
        logger.info({ stream: TENANTS_STREAM, durable: CONSUMER_NAME, filter: TENANT_CREATED_FILTER }, "Consuming TenantCreated events");
        try {
          for await (const message of messages) {
            const result = await handleTenantCreatedMessage(message.data, provision, logger);
            if (result === "ack") message.ack();
            else message.nak(this.nakDelayMs);
          }
        } finally {
          this.active = null;
        }
      } catch (error) {
        failures += 1;
        const text = isStreamMissing(error) ? "The TENANTS stream does not exist yet; trying again" : "The TenantCreated consumer failed; trying again";
        logger.warn({ stream: TENANTS_STREAM, durable: CONSUMER_NAME, attempt: failures, err: error }, text);
      }
      if (!this.stopping) await this.sleep(this.reconnectDelayMs);
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
