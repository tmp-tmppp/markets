import type { FastifyRequest } from "fastify";
import type { Actor, MarketRole } from "../usecases/ports.js";
import type { LookupViewer, MarketUseCases, ShareLinkUseCases } from "../usecases/use-cases.js";
import { requireMember } from "./auth.js";

export type UseCases = MarketUseCases & ShareLinkUseCases;

/**
 * Who is calling and which request it is; the use cases put this into the events they write. The tenant and the role
 * come only from the token (403 for a platform admin, a token without a tenant or without a market role), and the ids
 * that tie the events to the request are the correlation id of the caller and the id of this request.
 */
export function actorOf(request: FastifyRequest): Actor {
  const member = requireMember(request);
  return { ...member, correlationId: request.correlationId, causationId: request.id };
}

/**
 * Who asks the public lookup, as far as the token tells (contract v2): null for an anonymous caller. A platform admin
 * and a token without a tenant role have no role, so they are no member of any organization.
 */
export function viewerOf(request: FastifyRequest): LookupViewer | null {
  const auth = request.auth;
  if (!auth) return null;
  const role: MarketRole | null = auth.roles.includes("platform-admin")
    ? null
    : auth.roles.includes("tenant-admin")
      ? "tenant-admin"
      : auth.roles.includes("trader")
        ? "trader"
        : null;
  return { userId: auth.userId, tenantId: auth.tenantId, role, email: auth.email, emailVerified: auth.emailVerified };
}
