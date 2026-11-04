// Composition root and entry point: read configuration (defaults -> config file -> environment variables).

// Build the adapters (database repository, outbox) from the configuration, in-memory when no database is set.

// Build the use cases and inject the adapters through their port interfaces (constructor injection).

// Create the HTTP server with the web framework, register the web routes, listen on the configured port and shut down cleanly on SIGTERM.
