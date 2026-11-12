import type { Market, Outcome } from "./market.js";
import type { ShareLink } from "./share-link.js";
import type { LinkType } from "./sharing.js";

// Integration events as CloudEvents 1.0 (structured JSON). The shape is the contract in contracts/asyncapi.yaml.
// Events carry ids, never names or e-mails (DM-14).
export const EVENT_SOURCE = "/chance/markets";
export const SUBJECT_PREFIX = "chance.markets";

export type EventName = "MarketOpened" | "MarketClosed" | "MarketResolved" | "ShareLinkCreated" | "ShareLinkRevoked";

export interface CloudEvent<TData> {
  specversion: "1.0";
  id: string;
  source: typeof EVENT_SOURCE;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  tenantid: string;
  correlationid: string;
  causationid: string;
  data: TData;
}

/** What the use case knows about the event it is writing. */
export interface EventContext {
  eventId: string;
  now: Date;
  correlationId: string;
  causationId: string;
}

export interface MarketOpenedData {
  marketId: string;
  question: string;
  closeTime: string;
  startingPrice: number;
  fundingAmount: number;
  creatorId: string;
  version: number;
  openedAt: string;
}

export interface MarketClosedData {
  marketId: string;
  version: number;
  closedAt: string;
  closedBy: string;
}

export interface MarketResolvedData {
  marketId: string;
  outcome: Outcome;
  version: number;
  resolvedAt: string;
  resolvedBy: string;
  creatorId: string;
}

export function eventType(name: EventName): string {
  return `si.chance.markets.${name}.v1`;
}

/** NATS subject of an event: chance.markets.<Event>.<tenantId>. */
export function natsSubject(name: EventName, tenantId: string): string {
  return `${SUBJECT_PREFIX}.${name}.${tenantId}`;
}

/** CloudEvents subject of every market event. */
export function marketSubject(marketId: string): string {
  return `market/${marketId}`;
}

function envelope<TData>(name: EventName, market: Pick<Market, "id" | "tenantId">, ctx: EventContext, data: TData): CloudEvent<TData> {
  return {
    specversion: "1.0",
    id: ctx.eventId,
    source: EVENT_SOURCE,
    type: eventType(name),
    subject: marketSubject(market.id),
    time: ctx.now.toISOString(),
    datacontenttype: "application/json",
    tenantid: market.tenantId,
    correlationid: ctx.correlationId,
    causationid: ctx.causationId,
    data,
  };
}

/** A builder is called with the market after its transition; a missing field there is a programming error. */
function present<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`The market has no ${what}: build the event after the transition`);
  return value;
}

function expectStatus(market: Market, status: Market["status"], name: EventName): void {
  if (market.status !== status) throw new Error(`${name} needs a market that is ${status}, not ${market.status}`);
}

export function marketOpenedEvent(market: Market, ctx: EventContext): CloudEvent<MarketOpenedData> {
  expectStatus(market, "open", "MarketOpened");
  return envelope("MarketOpened", market, ctx, {
    marketId: market.id,
    question: market.question,
    closeTime: market.closeTime.toISOString(),
    startingPrice: market.startingPrice,
    fundingAmount: market.fundingAmount,
    creatorId: market.createdBy,
    version: market.version,
    openedAt: present(market.openedAt, "openedAt").toISOString(),
  });
}

export function marketClosedEvent(market: Market, ctx: EventContext): CloudEvent<MarketClosedData> {
  expectStatus(market, "closed", "MarketClosed");
  return envelope("MarketClosed", market, ctx, {
    marketId: market.id,
    version: market.version,
    closedAt: present(market.closedAt, "closedAt").toISOString(),
    closedBy: present(market.closedBy, "closedBy"),
  });
}

/** A share link was made. The data names the link by its id: the token and the e-mail addresses never leave the service (DM-14). */
export interface ShareLinkCreatedData {
  marketId: string;
  shareLinkId: string;
  linkType: LinkType;
  /** The user who made the link; the audit log reads this key as the actor. */
  actorId: string;
  expiresAt: string | null;
}

export interface ShareLinkRevokedData {
  marketId: string;
  shareLinkId: string;
  actorId: string;
  revokedAt: string;
}

export function shareLinkCreatedEvent(link: ShareLink, ctx: EventContext): CloudEvent<ShareLinkCreatedData> {
  return envelope("ShareLinkCreated", { id: link.marketId, tenantId: link.tenantId }, ctx, {
    marketId: link.marketId,
    shareLinkId: link.id,
    linkType: link.type,
    actorId: link.createdBy,
    expiresAt: link.expiresAt?.toISOString() ?? null,
  });
}

export function shareLinkRevokedEvent(link: ShareLink, actorId: string, revokedAt: Date, ctx: EventContext): CloudEvent<ShareLinkRevokedData> {
  return envelope("ShareLinkRevoked", { id: link.marketId, tenantId: link.tenantId }, ctx, {
    marketId: link.marketId,
    shareLinkId: link.id,
    actorId,
    revokedAt: revokedAt.toISOString(),
  });
}

export function marketResolvedEvent(market: Market, ctx: EventContext): CloudEvent<MarketResolvedData> {
  expectStatus(market, "resolved", "MarketResolved");
  return envelope("MarketResolved", market, ctx, {
    marketId: market.id,
    outcome: present(market.outcome, "outcome"),
    version: market.version,
    resolvedAt: present(market.resolvedAt, "resolvedAt").toISOString(),
    resolvedBy: present(market.resolvedBy, "resolvedBy"),
    creatorId: market.createdBy,
  });
}
