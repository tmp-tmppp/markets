import type { FastifyInstance } from "fastify";
import type { ShareLinkUseCases, ShareLinkView } from "../../usecases/use-cases.js";
import { memberHook, requireServiceClient } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { actorOf, viewerOf } from "../context.js";
import { schemas } from "../schemas.js";

/** A share link as `components/schemas/ShareLink` of contracts/openapi.yaml: dates as ISO 8601 text, never the token or its hash. */
export const shareLinkBody = (link: ShareLinkView) => ({
  id: link.id,
  marketId: link.marketId,
  type: link.type,
  emails: [...link.emails],
  createdBy: link.createdBy,
  createdAt: link.createdAt.toISOString(),
  expiresAt: link.expiresAt?.toISOString() ?? null,
  revokedAt: link.revokedAt?.toISOString() ?? null,
  status: link.status,
});

export interface ShareLinkHooks {
  /** onRequest of the routes of a signed-in member: 401 first. */
  authenticate: RequestHook;
  /** onRequest of the public lookup: no header is an anonymous caller, a wrong token is still 401. */
  authenticateIfPresent: RequestHook;
  /** onRequest of the internal endpoint: verifies the service token. */
  authenticateService: RequestHook;
  /** The client id of the service that may call the internal endpoint (tenants). */
  tenantsClientId: string;
}

/**
 * The share-link routes (tag Sharing and Internal of contracts/openapi.yaml). The routes of a member check the role before
 * they validate anything, like the market routes; the tenant always comes from the token. The token of a link travels in
 * a request body only, and the answer that carries one (the creation) is the only place it is ever written.
 */
export function registerShareLinkRoutes(app: FastifyInstance, useCases: ShareLinkUseCases, hooks: ShareLinkHooks): void {
  app.post<{ Params: { id: string }; Body: { type: "members" | "profiles" | "everyone"; emails?: string[]; expiresAt?: string } }>(
    "/v1/markets/:id/share-links",
    { schema: schemas.createShareLink, onRequest: hooks.authenticate, preValidation: memberHook },
    async (request, reply) => {
      const { link, token } = await useCases.createShareLink.execute({
        actor: actorOf(request),
        marketId: request.params.id.toLowerCase(),
        type: request.body.type,
        emails: request.body.emails,
        expiresAt: request.body.expiresAt,
      });
      return reply
        .code(201)
        .header("location", `/v1/markets/${link.marketId}/share-links/${link.id}`)
        .send({ ...shareLinkBody(link), token, urlPath: `/share#${token}` });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>(
    "/v1/markets/:id/share-links",
    { schema: schemas.listShareLinks, onRequest: hooks.authenticate, preValidation: memberHook },
    async (request) => {
      const page = await useCases.listShareLinks.execute({
        actor: actorOf(request),
        marketId: request.params.id.toLowerCase(),
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return { items: page.items.map(shareLinkBody), nextCursor: page.nextCursor };
    },
  );

  app.delete<{ Params: { id: string; linkId: string } }>(
    "/v1/markets/:id/share-links/:linkId",
    { schema: schemas.revokeShareLink, onRequest: hooks.authenticate, preValidation: memberHook },
    async (request, reply) => {
      await useCases.revokeShareLink.execute({
        actor: actorOf(request),
        marketId: request.params.id.toLowerCase(),
        linkId: request.params.linkId.toLowerCase(),
      });
      return reply.code(204).send();
    },
  );

  // Public: no role check. The caller is whoever the optional token says; the use case decides what the link shows them.
  app.post<{ Body: { token: string } }>(
    "/v1/shared-markets/lookup",
    { schema: schemas.lookupSharedMarket, onRequest: hooks.authenticateIfPresent },
    async (request) => {
      const found = await useCases.lookupSharedMarket.execute({ token: request.body.token, viewer: viewerOf(request) });
      return {
        linkType: found.linkType,
        market: { id: found.market.id, question: found.market.question, status: found.market.status, closeTime: found.market.closeTime.toISOString() },
        organization: found.organization,
        next: found.next,
      };
    },
  );

  // Internal: tenants only. The check of the client runs before the body is validated.
  app.post<{ Body: { token: string; userEmail: string | null; emailVerified: boolean } }>(
    "/v1/internal/share-links/admission",
    { schema: schemas.admitShareLink, onRequest: hooks.authenticateService, preValidation: requireServiceClient(hooks.tenantsClientId) },
    async (request) =>
      useCases.admitShareLink.execute({ token: request.body.token, userEmail: request.body.userEmail, emailVerified: request.body.emailVerified }),
  );
}
