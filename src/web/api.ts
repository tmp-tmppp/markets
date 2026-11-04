// Routes builder: registers the HTTP routes on the web framework (Fastify or NestJS, still to be chosen) from the injected use cases.

// Health endpoints: startup, readiness (own database only) and liveness (process only).

// POST /v1/markets: tenant admin creates a draft market (request and response bodies validated against schemas, tool chosen with the framework).

// GET /v1/markets and GET /v1/markets/{id}: list (paginated, filter by status) and detail.

// Map use-case errors to HTTP status codes (not found -> 404, invalid transition -> 409, validation -> 422).
