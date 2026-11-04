# markets

<!-- Responsibility: market lifecycle draft -> open -> closed -> resolved for each tenant. -->

<!-- Stack: TypeScript on Node.js (LTS); web framework (Fastify or NestJS), database and message broker still to be decided. -->

<!-- Layout: src/domain -> src/usecases -> src/adapters / src/web (Clean Architecture), src/main.ts composition root, tests/, package.json, tsconfig.json, Dockerfile, helm/, .github/workflows/. -->

<!-- How to run locally and run the tests: npm ci, npm run typecheck, npm test (test runner still to be chosen), npm run build, npm start. -->

<!-- Configuration parameters table: name, purpose, default. -->

<!-- How it deploys: CI/CD pointer to the organization profile, prod on every push to main. -->

<!-- What it needs: its own database, the message broker, the identity provider's signing keys, trading (funding on open). -->
