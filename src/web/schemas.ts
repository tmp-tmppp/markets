import { MARKET_STATUSES, OUTCOMES } from "../domain/market.js";
import { LINK_TYPES, WHO_MAY_SHARE } from "../domain/sharing.js";

// JSON schemas of the routes: they validate the input and shape the output. They mirror contracts/openapi.yaml,
// and tests/contracts compares the routes with that file.
//
// The text and number rules of a new market (question 10 to 200 characters after trimming, description, close time
// window, price with two decimals, funding bounds from the runtime configuration) are the domain's: they depend on
// trimming, on the clock and on settings that change while the service runs, so the schema only checks types and
// leaves the field-named answer to the domain.
const uuid = { type: "string", format: "uuid" } as const;
const dateTime = { type: "string", format: "date-time" } as const;
const nullableDateTime = { type: ["string", "null"] } as const;
const nullableText = { type: ["string", "null"] } as const;
const status = { type: "string", enum: [...MARKET_STATUSES] } as const;
const outcome = { type: "string", enum: [...OUTCOMES] } as const;

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

export const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
    // Extension members of the 403 share_link_not_permitted of the lookup (contracts/openapi.yaml, `Problem`).
    organization: { type: "object", properties: { name: { type: ["string", "null"] } } },
    next: { type: "array", items: { type: "string" } },
  },
} as const;

const whoMayShare = { type: "string", enum: [...WHO_MAY_SHARE] } as const;
const linkType = { type: "string", enum: [...LINK_TYPES] } as const;
/** A share token as the sharer received it: 32 random bytes in base64url. The pattern never echoes the value it refuses. */
const token = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } as const;

const sharingPolicy = {
  type: "object",
  properties: { whoMayShare, linkTypes: { type: "array", items: linkType } },
} as const;

const shareLink = {
  type: "object",
  properties: {
    id: uuid,
    marketId: uuid,
    type: linkType,
    emails: { type: "array", items: { type: "string" } },
    createdBy: { type: "string" },
    createdAt: dateTime,
    expiresAt: nullableDateTime,
    revokedAt: nullableDateTime,
    status: { type: "string", enum: ["active", "revoked", "expired"] },
  },
} as const;

const next = { type: "array", items: { type: "string", enum: ["sign_in", "join", "switch_organization", "trade"] } } as const;

const market = {
  type: "object",
  properties: {
    sharing: sharingPolicy,
    id: uuid,
    tenantId: uuid,
    question: { type: "string" },
    description: { type: "string" },
    closeTime: dateTime,
    startingPrice: { type: "number" },
    fundingAmount: { type: "integer" },
    status,
    outcome: { type: ["string", "null"], enum: [...OUTCOMES, null] },
    version: { type: "integer" },
    createdBy: { type: "string" },
    createdAt: dateTime,
    updatedAt: dateTime,
    openedAt: nullableDateTime,
    closedAt: nullableDateTime,
    closedBy: nullableText,
    resolvedAt: nullableDateTime,
    resolvedBy: nullableText,
  },
} as const;

const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const marketParams = {
  type: "object",
  required: ["id"],
  properties: { id: uuid },
} as const;

export const schemas = {
  listMarkets: {
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: {
        status,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    response: {
      200: {
        type: "object",
        properties: { items: { type: "array", items: market }, nextCursor: { type: ["string", "null"] } },
      },
      ...errorResponses,
    },
  },
  getMarket: {
    params: marketParams,
    response: { 200: market, ...errorResponses },
  },
  createMarket: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["question", "closeTime", "startingPrice", "fundingAmount"],
      properties: {
        question: { type: "string" },
        description: { type: "string" },
        closeTime: { type: "string" },
        startingPrice: { type: "number" },
        fundingAmount: { type: "integer" },
        // The domain checks the fields and their values and names the field; the schema only keeps it an object.
        sharing: { type: "object" },
      },
    },
    response: { 201: market, ...errorResponses },
  },
  // Open and close take no body: the market is named by the path alone.
  openMarket: {
    params: marketParams,
    response: { 200: market, 202: market, ...errorResponses },
  },
  closeMarket: {
    params: marketParams,
    response: { 200: market, ...errorResponses },
  },
  resolveMarket: {
    params: marketParams,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
      properties: { outcome },
    },
    response: { 200: market, ...errorResponses },
  },
  createShareLink: {
    params: marketParams,
    body: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: linkType,
        // The domain checks the count and every address and names the field.
        emails: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string" },
      },
    },
    response: { 201: { type: "object", properties: { ...shareLink.properties, token: { type: "string" }, urlPath: { type: "string" } } }, ...errorResponses },
  },
  listShareLinks: {
    params: marketParams,
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    response: {
      200: { type: "object", properties: { items: { type: "array", items: shareLink }, nextCursor: { type: ["string", "null"] } } },
      ...errorResponses,
    },
  },
  revokeShareLink: {
    params: { type: "object", required: ["id", "linkId"], properties: { id: uuid, linkId: uuid } },
    response: { 204: { type: "null" }, ...errorResponses },
  },
  lookupSharedMarket: {
    body: { type: "object", additionalProperties: false, required: ["token"], properties: { token } },
    response: {
      200: {
        type: "object",
        properties: {
          linkType,
          market: { type: "object", properties: { id: uuid, question: { type: "string" }, status, closeTime: dateTime } },
          organization: { type: "object", properties: { alias: uuid, name: { type: ["string", "null"] } } },
          next,
        },
      },
      ...errorResponses,
    },
  },
  admitShareLink: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["token", "userEmail", "emailVerified"],
      properties: { token, userEmail: { type: ["string", "null"], maxLength: 320 }, emailVerified: { type: "boolean" } },
    },
    response: {
      200: {
        type: "object",
        properties: { decision: { type: "string", enum: ["join", "members_only", "denied"] }, linkType, tenantId: uuid, marketId: uuid },
      },
      ...errorResponses,
    },
  },
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },
} as const;
