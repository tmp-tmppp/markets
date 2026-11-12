import { Ajv } from "ajv";
import type { SchemaObject } from "ajv";
import addFormats from "ajv-formats";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { v7 as uuidv7 } from "uuid";
import { authenticate, authenticateIfPresent, authenticateService } from "./auth.js";
import type { AuthOptions, ServiceAuthOptions } from "./auth.js";
import type { UseCases } from "./context.js";
import { frameworkErrorHandler, noStoreForApi, registerProblemHandlers } from "./problems.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HealthChecks } from "./routes/health.js";
import { registerMarketRoutes } from "./routes/markets.js";
import { registerShareLinkRoutes } from "./routes/share-links.js";

export interface WebDeps {
  logger: PinoLogger;
  useCases: UseCases;
  auth: AuthOptions;
  /** The internal surface: the service tokens, and the client id of tenants (the only caller of the admission endpoint). */
  internal: ServiceAuthOptions & { tenantsClientId: string };
  health: HealthChecks;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Every route that was registered, for the contract tests. */
    registeredRoutes: RegisteredRoute[];
  }
}

// Letters, digits and a few separators, so a client cannot inject anything odd into logs and headers.
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The longest path parameter the router accepts, measured on the raw text of the URL. Fastify's default is 100, which
 * is more than a market id (a UUID, 36 characters) needs: a value up to this length gets the 400 of the schema, a longer one
 * the 414 problem of frameworkErrorHandler.
 */
const MAX_PARAM_LENGTH = 512;

/** The options Fastify's own validator uses, except that every error is reported and unknown fields are kept for the schema to refuse. */
const VALIDATOR_OPTIONS = { allErrors: true, removeAdditional: false, useDefaults: true, allowUnionTypes: true };

/** Builds the Fastify application (not started): tests call it with app.inject. */
export function buildApp(deps: WebDeps): FastifyInstance {
  const logger: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    genReqId: () => uuidv7(),
    exposeHeadRoutes: false,
    bodyLimit: 16 * 1024,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    frameworkErrors: frameworkErrorHandler,
  });

  // The body is checked strictly: a string price, a numeric question or a null description is a 400, not a silent
  // conversion (the contract says number, integer and string). The querystring, the path and the headers arrive as text
  // and keep the coercion (?limit=2).
  const strict = new Ajv({ ...VALIDATOR_OPTIONS, coerceTypes: false });
  const coercing = new Ajv({ ...VALIDATOR_OPTIONS, coerceTypes: "array" });
  addFormats.default(strict);
  addFormats.default(coercing);
  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === "body" ? strict : coercing).compile(schema as SchemaObject));

  // A POST that needs no body (open, close) may still carry Content-Type: application/json, as curl and many fetch
  // wrappers send it: an empty body is "no body", not a 400. Fastify's own parser stays for everything else (prototype
  // poisoning guard, 400 on malformed JSON), and a route whose schema needs a body still answers 400 for an empty one.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    // parseAs "string" always gives text; the Buffer branch only satisfies the type.
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text === "") {
      done(null, undefined);
      return;
    }
    // The default parser answers through `done`; the type also allows a promise, which is never returned here.
    void parseJson(request, text, done);
  });

  const registeredRoutes: RegisteredRoute[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method, url: route.url });
  });

  app.decorateRequest("auth", null);
  app.decorateRequest("correlationId", "");
  app.decorateRequest("serviceClient", null);

  // Correlation: take X-Correlation-Id from the caller or make one, return it and bind it to the request logger.
  app.addHook("onRequest", (request, reply, done) => {
    const sent = request.headers["x-correlation-id"];
    request.correlationId = typeof sent === "string" && CORRELATION_ID.test(sent) ? sent : uuidv7();
    reply.header("x-correlation-id", request.correlationId);
    request.log = reply.log = request.log.child({ correlationId: request.correlationId });
    done();
  });

  // INF-02: every /v1/ answer carries Cache-Control: private, no-store (see noStoreForApi).
  app.addHook("onSend", (request, reply, payload, done) => {
    noStoreForApi(request, reply);
    done(null, payload);
  });

  // Before the routes, so that every response is counted, also the 404 of a path that matches no route.
  deps.metrics?.attach(app);

  registerProblemHandlers(app);

  const authHook = authenticate(deps.auth);
  registerHealthRoutes(app, deps.health);
  registerMarketRoutes(app, deps.useCases, authHook);
  registerShareLinkRoutes(app, deps.useCases, {
    authenticate: authHook,
    authenticateIfPresent: authenticateIfPresent(deps.auth),
    authenticateService: authenticateService(deps.internal),
    tenantsClientId: deps.internal.tenantsClientId,
  });

  return app;
}
