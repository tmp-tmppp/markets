import { readTenantCreated } from "../../domain/tenant.js";
import type { Logger } from "../../usecases/ports.js";
import type { ProvisionTenantUseCase } from "../../usecases/use-cases.js";

/** What the consumer does with the message: acknowledge it, or ask the broker to deliver it again later. */
export type HandleResult = "ack" | "nak";

/**
 * One message of the TENANTS stream, without any NATS type, so that the rules are unit-tested (ADR-053 inbox).
 *  - A message that is not JSON, not a CloudEvent 1.0, of another type or malformed: a warning and "ack". A poison
 *    message must never block the consumer, and redelivering it would change nothing.
 *  - TenantCreated: the use case records the event id in the inbox, creates and migrates the tenant's schema and
 *    registers it, in one transaction. "provisioned" and "duplicate" (a redelivery) both end in "ack".
 *  - Any error of the use case (database down, a migration failing): an error log and "nak", so the broker delivers it
 *    again after a delay. The transaction was rolled back, so nothing is half done. The consumer acknowledges only
 *    after this function returned "ack", that is after the commit.
 */
export async function handleTenantCreatedMessage(data: Uint8Array, provision: ProvisionTenantUseCase, logger: Logger): Promise<HandleResult> {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(data));
  } catch {
    logger.warn({ bytes: data.byteLength }, "A message of the TENANTS stream is not JSON; it is acknowledged and skipped");
    return "ack";
  }
  const event = readTenantCreated(body);
  if (event.kind === "ignored") {
    logger.warn({ eventId: event.eventId, reason: event.reason }, "A message of the TENANTS stream is not a usable TenantCreated event; it is acknowledged and skipped");
    return "ack";
  }
  const { notice } = event;
  try {
    const result = await provision.execute(notice);
    logger.info({ tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId, result }, "TenantCreated handled");
    return "ack";
  } catch (error) {
    logger.error(
      { tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId, err: error },
      "TenantCreated could not be processed; it will be delivered again",
    );
    return "nak";
  }
}
