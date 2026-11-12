import type { FastifyInstance } from "fastify";
import type { Market, MarketStatus } from "../../domain/market.js";
import { memberHook, tenantAdminHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { actorOf } from "../context.js";
import type { UseCases } from "../context.js";
import { schemas } from "../schemas.js";

/** A market as `components/schemas/Market` of contracts/openapi.yaml: dates as ISO 8601 text. */
export const marketBody = (m: Market) => ({
  id: m.id,
  tenantId: m.tenantId,
  question: m.question,
  description: m.description,
  closeTime: m.closeTime.toISOString(),
  startingPrice: m.startingPrice,
  fundingAmount: m.fundingAmount,
  status: m.status,
  outcome: m.outcome,
  version: m.version,
  createdBy: m.createdBy,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
  openedAt: m.openedAt?.toISOString() ?? null,
  closedAt: m.closedAt?.toISOString() ?? null,
  closedBy: m.closedBy,
  resolvedAt: m.resolvedAt?.toISOString() ?? null,
  resolvedBy: m.resolvedBy,
  sharing: { whoMayShare: m.sharing.whoMayShare, linkTypes: [...m.sharing.linkTypes] },
});

interface IdParams {
  id: string;
}

/**
 * Routes of the tenant's markets. Authentication is an onRequest hook (401 first); the role checks run in preValidation,
 * before the query, the path or the body is validated, so a caller without rights learns nothing from validation.
 * The tenant is never read from the request: the use cases get it from the token (actorOf).
 */
export function registerMarketRoutes(app: FastifyInstance, useCases: UseCases, authenticate: RequestHook): void {
  app.get<{ Querystring: { status?: MarketStatus; limit?: number; cursor?: string } }>(
    "/v1/markets",
    { schema: schemas.listMarkets, onRequest: authenticate, preValidation: memberHook },
    async (request) => {
      const page = await useCases.listMarkets.execute({
        actor: actorOf(request),
        status: request.query.status,
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return { items: page.items.map(marketBody), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: IdParams }>(
    "/v1/markets/:id",
    { schema: schemas.getMarket, onRequest: authenticate, preValidation: memberHook },
    async (request) => marketBody(await useCases.getMarket.execute({ actor: actorOf(request), marketId: request.params.id.toLowerCase() })),
  );

  app.post<{ Body: { question: string; description?: string; closeTime: string; startingPrice: number; fundingAmount: number; sharing?: unknown } }>(
    "/v1/markets",
    { schema: schemas.createMarket, onRequest: authenticate, preValidation: tenantAdminHook },
    async (request, reply) => {
      const market = await useCases.createMarket.execute({
        actor: actorOf(request),
        question: request.body.question,
        description: request.body.description,
        closeTime: request.body.closeTime,
        startingPrice: request.body.startingPrice,
        fundingAmount: request.body.fundingAmount,
        sharing: request.body.sharing,
      });
      return reply.code(201).header("location", `/v1/markets/${market.id}`).send(marketBody(market));
    },
  );

  // 200: funded and open. 202: the funding outcome is unknown, the market is (still) opening and a worker repeats the call.
  app.post<{ Params: IdParams }>(
    "/v1/markets/:id/open",
    { schema: schemas.openMarket, onRequest: authenticate, preValidation: tenantAdminHook },
    async (request, reply) => {
      const { market, state } = await useCases.openMarket.execute({ actor: actorOf(request), marketId: request.params.id.toLowerCase() });
      return reply.code(state === "open" ? 200 : 202).send(marketBody(market));
    },
  );

  app.post<{ Params: IdParams }>(
    "/v1/markets/:id/close",
    { schema: schemas.closeMarket, onRequest: authenticate, preValidation: tenantAdminHook },
    async (request) => marketBody(await useCases.closeMarket.execute({ actor: actorOf(request), marketId: request.params.id.toLowerCase() })),
  );

  app.post<{ Params: IdParams; Body: { outcome: string } }>(
    "/v1/markets/:id/resolve",
    { schema: schemas.resolveMarket, onRequest: authenticate, preValidation: tenantAdminHook },
    async (request) =>
      marketBody(
        await useCases.resolveMarket.execute({
          actor: actorOf(request),
          marketId: request.params.id.toLowerCase(),
          outcome: request.body.outcome,
        }),
      ),
  );
}
