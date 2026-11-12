import { errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isTenantId } from "../domain/tenant.js";
import type { MarketRole } from "../usecases/ports.js";
import { HttpError } from "./problems.js";

export interface AuthOptions {
  issuer: string;
  audience: string;
  /** Resolves the signing key of a token: the identity provider's JWKS in production, a local key in tests. */
  getKey: JWTVerifyGetKey;
  /** Dot path of the realm roles in the token, for example "realm_access.roles". */
  rolesClaim: string;
  /** Dot path of the organization claim, for example "organization". */
  tenantClaim: string;
}

export interface AuthContext {
  userId: string;
  /**
   * Token contract v2: the realm roles of the token without `trader` and `tenant-admin` (a realm role of that name counts
   * for nothing), plus the one tenant role of the token's organization, read from its group.
   */
  roles: readonly string[];
  /** The tenant of the token: the single organization alias, or null when the token has none. */
  tenantId: string | null;
  /** The `email` claim; null when the token has none. */
  email: string | null;
  /** True only when the `email_verified` claim is the boolean true. */
  emailVerified: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    correlationId: string;
  }
}

// Only asymmetric algorithms: a token can never be accepted with a shared secret or without a signature.
const ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256", "PS384", "PS512", "EdDSA"];

function unauthorized(detail: string, challenge: string): HttpError {
  return new HttpError(401, "unauthorized", detail, { "www-authenticate": challenge });
}

/** Seconds a client is told to wait when the signing keys cannot be fetched; the key fetch has its own timeout. */
export const KEYS_RETRY_AFTER_SECONDS = 5;

/** The tokens cannot be checked because the identity provider's signing keys are not available: 503, not 401. */
function keysUnavailable(): HttpError {
  return new HttpError(
    503,
    "identity_provider_unavailable",
    "The signing keys of the identity provider cannot be fetched; try again shortly",
    { "retry-after": String(KEYS_RETRY_AFTER_SECONDS) },
  );
}

/** A failure to fetch the signing keys, as opposed to a token that is wrong. Thrown by the key resolver only. */
class SigningKeysUnavailable extends Error {
  constructor(cause: unknown) {
    super("The signing keys cannot be fetched", { cause });
    this.name = "SigningKeysUnavailable";
  }
}

/**
 * Whether an error of the key resolver means the key set could not be fetched or read: a timeout, a key set that
 * is malformed, a bad HTTP status or body (jose throws its base class JOSEError, with no subclass, only for these
 * two), or anything that is not a jose error at all (a network error is a TypeError). Errors about the token
 * itself (an unknown or ambiguous key id) are JOSEError subclasses and stay 401.
 */
function isKeyFetchFailure(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  if (!(error instanceof errors.JOSEError)) return true;
  return error.code === errors.JOSEError.code;
}

/** Marks the failures of the key resolver, so that they are told apart from the errors about the token. */
function marked(getKey: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await getKey(protectedHeader, token);
    } catch (error) {
      throw isKeyFetchFailure(error) ? new SigningKeysUnavailable(error) : error;
    }
  };
}

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Token contract v2: the tenant role is the group of the token's one organization, "/tenant-admin" or "/trader" in
 * `organization.<alias>.groups`. Keycloak copies the roles of an organization group into the realm roles of every
 * organization, so no role is ever mapped on those groups and the realm roles carry no tenant role.
 */
const TENANT_GROUPS: ReadonlyMap<string, string> = new Map([
  ["/tenant-admin", "tenant-admin"],
  ["/trader", "trader"],
]);
const TENANT_ROLES: ReadonlySet<string> = new Set(TENANT_GROUPS.values());

/** The realm roles of the token. A tenant role found here is ignored: it counts only as a group of the organization. */
function realmRolesOf(payload: JWTPayload, claim: string): string[] {
  const value = readPath(payload, claim);
  return Array.isArray(value) ? value.filter((role): role is string => typeof role === "string" && !TENANT_ROLES.has(role)) : [];
}

interface TokenOrganization {
  alias: string;
  groups: string[];
}

function groupsOf(entry: unknown): string[] {
  const groups = readPath(entry, "groups");
  return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === "string") : [];
}

/**
 * The organization claim is an object keyed by alias (each value holds the organization's groups); an array of aliases
 * or one alias as text is accepted too, without groups. Exactly one organization is allowed.
 */
function organizationOf(payload: JWTPayload, claim: string): TokenOrganization | null {
  const value = readPath(payload, claim);
  const found: TokenOrganization[] = [];
  if (typeof value === "string") {
    found.push({ alias: value, groups: [] });
  } else if (Array.isArray(value)) {
    for (const alias of value) if (typeof alias === "string") found.push({ alias, groups: [] });
  } else if (typeof value === "object" && value !== null) {
    for (const [alias, entry] of Object.entries(value)) found.push({ alias, groups: groupsOf(entry) });
  }
  if (found.length > 1) {
    throw unauthorized("The token belongs to more than one organization", 'Bearer error="invalid_token"');
  }
  return found[0] ?? null;
}

/** The tenant role of a list of groups: only when exactly one tenant role is among them, otherwise none. */
function tenantRolesOf(groups: readonly string[]): string[] {
  const roles = new Set<string>();
  for (const group of groups) {
    const role = TENANT_GROUPS.get(group);
    if (role !== undefined) roles.add(role);
  }
  return roles.size === 1 ? [...roles] : [];
}

/** What a bearer token has to prove, for user tokens and service tokens alike. */
export interface BearerOptions {
  issuer: string;
  audience: string;
  getKey: JWTVerifyGetKey;
}

/**
 * The first part of every authentication: the Authorization header, the signature, the issuer, the audience and a
 * required exp. Returns the payload; a wrong token is 401, signing keys that cannot be fetched are 503.
 */
function bearerVerifier(options: BearerOptions): (request: FastifyRequest) => Promise<JWTPayload> {
  const getKey = marked(options.getKey);
  return async (request) => {
    const header = request.headers.authorization;
    if (!header) throw unauthorized("A bearer token is required", "Bearer");
    const [scheme, token, ...rest] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
      throw unauthorized("The Authorization header must be: Bearer <token>", "Bearer");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ALGORITHMS,
        // Without it, a token that carries no exp would never expire.
        requiredClaims: ["exp"],
      }));
    } catch (error) {
      if (error instanceof SigningKeysUnavailable) {
        request.log.warn({ err: error.cause }, "The signing keys of the identity provider cannot be fetched");
        throw keysUnavailable();
      }
      request.log.info({ reason: error instanceof Error ? error.name : "unknown" }, "A token was rejected");
      throw unauthorized("The token is not valid", 'Bearer error="invalid_token"');
    }
    return payload;
  };
}

/** onRequest hook: verifies the bearer token and puts the caller on the request. */
export function authenticate(options: AuthOptions) {
  const verify = bearerVerifier(options);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const payload = await verify(request);
    if (!payload.sub) throw unauthorized("The token has no subject", 'Bearer error="invalid_token"');

    const organization = organizationOf(payload, options.tenantClaim);
    const auth: AuthContext = {
      userId: payload.sub,
      roles: [...realmRolesOf(payload, options.rolesClaim), ...tenantRolesOf(organization?.groups ?? [])],
      tenantId: organization?.alias ?? null,
      email: typeof payload["email"] === "string" && payload["email"].length > 0 ? payload["email"] : null,
      emailVerified: payload["email_verified"] === true,
    };
    request.auth = auth;
    request.log = reply.log = request.log.child({ userId: auth.userId, tenantId: auth.tenantId });
  };
}

/**
 * onRequest hook of a public endpoint that may know who asks: without an Authorization header the caller is anonymous
 * (`request.auth` stays null); with one, the token is checked exactly as everywhere else, so a wrong one is still 401.
 */
export function authenticateIfPresent(options: AuthOptions): RequestHook {
  const authenticateRequest = authenticate(options);
  return async (request, reply) => {
    if (request.headers.authorization === undefined) return;
    await authenticateRequest(request, reply);
  };
}

/**
 * The internal surface: the tokens of the identity provider's client-credentials grant, verified like user tokens
 * (signature, issuer, required exp) against their own audience. The claim `azp` names the calling client, and the
 * endpoint admits exactly one client. A user's token has another `azp` (the web client), so it never passes.
 */
export interface ServiceAuthOptions extends BearerOptions {
  /** The claim that carries the client id of the token, for example "azp". */
  clientClaim: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The client id of a verified service token (internal endpoints only); null on every other request. */
    serviceClient: string | null;
  }
}

/** onRequest hook of the internal endpoints: verifies the service token and puts the client id on the request. */
export function authenticateService(options: ServiceAuthOptions): RequestHook {
  const verify = bearerVerifier(options);
  return async (request, reply) => {
    const payload = await verify(request);
    const claim = readPath(payload, options.clientClaim);
    request.serviceClient = typeof claim === "string" && claim !== "" ? claim : null;
    // A client id is a public name, not a secret: it tells the callers apart in the logs.
    request.log = reply.log = request.log.child({ client: request.serviceClient });
  };
}

/** preValidation hook of an internal endpoint: the token belongs to this one client (403 for any other, also a user's), before validation. */
export function requireServiceClient(clientId: string): RequestHook {
  return (request) =>
    Promise.resolve().then(() => {
      // A token without the claim is no service token either: the same 403.
      if (request.serviceClient !== clientId) {
        throw new HttpError(403, "forbidden", "The token belongs to another client than this endpoint admits");
      }
    });
}

/**
 * The tenant label of the request metrics: the tenant id of the token this service verified, or null. `request.auth` is
 * set only after the token check succeeded (a service token of the internal surface never sets it), so a request without
 * a valid user token is "none"; a header or the body is never read. src/main.ts and the tests use this one function.
 */
export function tenantOfRequest(request: FastifyRequest): string | null {
  return request.auth?.tenantId ?? null;
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized("A bearer token is required", "Bearer");
  return request.auth;
}

export interface Member {
  userId: string;
  /** The tenant of the token, a UUID in lower case. */
  tenantId: string;
  role: MarketRole;
}

/**
 * Guard of every markets endpoint: the caller is a trader or a tenant admin of the tenant named by the token. A platform
 * admin sees no tenant's data (403, even when the token also names a tenant or a tenant role), and so does a token without
 * a tenant, with a tenant that is not a UUID, or with neither role. The role `tenant-admin` wins when both are present.
 * The tenant is always the token's, never the request's.
 */
export function requireMember(request: FastifyRequest): Member {
  const auth = requireAuth(request);
  if (auth.roles.includes("platform-admin")) {
    throw new HttpError(403, "forbidden", "The platform-admin role has no access to a tenant's markets");
  }
  if (auth.tenantId === null || !isTenantId(auth.tenantId)) {
    throw new HttpError(403, "forbidden", "The token does not belong to a tenant");
  }
  const role: MarketRole | null = auth.roles.includes("tenant-admin") ? "tenant-admin" : auth.roles.includes("trader") ? "trader" : null;
  if (role === null) throw new HttpError(403, "forbidden", "The trader or tenant-admin role is required");
  return { userId: auth.userId, tenantId: auth.tenantId.toLowerCase(), role };
}

/** Guard of the endpoints that change something: a tenant admin of the token's tenant. */
export function requireTenantAdmin(request: FastifyRequest): Member {
  const member = requireMember(request);
  if (member.role !== "tenant-admin") throw new HttpError(403, "forbidden", "The tenant-admin role is required");
  return member;
}

/** The checks above as async hooks: Fastify waits for the returned promise, and a thrown error becomes the answer. */
export type RequestHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** preValidation hook of the read routes: answers 403 before the query or the path is validated. */
export const memberHook: RequestHook = (request) =>
  Promise.resolve().then(() => {
    requireMember(request);
  });

/** preValidation hook of the POST routes: answers 403 before the body is validated. */
export const tenantAdminHook: RequestHook = (request) =>
  Promise.resolve().then(() => {
    requireTenantAdmin(request);
  });
