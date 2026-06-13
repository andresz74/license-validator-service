# Repository Guidelines

## Project Structure & Module Organization

This is a small Node.js/Express license validation API. The main application lives in `index.js`, which exports `createApp` for tests and starts the server when run directly. Tests are in `__tests__/app.test.js` and use Jest with Supertest. `vercel.json` contains Vercel deployment routing and headers. `licenses.json` is sample legacy license data; runtime validation now depends on the MongoDB `licenseDatabase.licenses` collection. Keep new API behavior close to `index.js` unless the service grows enough to justify splitting routes or data access.

## Build, Test, and Development Commands

- `npm install`: install runtime and test dependencies from `package-lock.json`.
- `npm start`: run `node index.js` locally on `PORT` or `3000`.
- `npm test`: run the Jest test suite.

Local startup requires `MONGODB_URI`:

```bash
export MONGODB_URI="mongodb+srv://user:pass@cluster.example.mongodb.net"
npm start
```

Use `/health` to verify MongoDB readiness and `/validate-license?key=<licenseId>` to exercise validation.

## Coding Style & Naming Conventions

Use CommonJS modules (`require`, `module.exports`) and 2-space indentation, matching the existing files. Prefer `const` by default and `let` only for mutable state. Keep response bodies structured with stable `message` and `code` fields for errors. Name tests with behavior-focused descriptions, for example `returns structured error when database not ready`. There is no configured formatter or linter, so keep changes consistent with the surrounding code.

## Testing Guidelines

Tests use Jest and Supertest. Add or update tests in `__tests__/app.test.js` when changing routes, response codes, MongoDB readiness behavior, rate limiting, or license update logic. Inject dependencies through `createApp` instead of connecting to a real database in tests. Run `npm test` before opening a pull request.

## Commit & Pull Request Guidelines

Recent history uses short imperative messages and occasional Conventional Commit prefixes, such as `feat: create license-validator service` and `Add MongoDB readiness checks and health endpoint (#2)`. Keep commits focused and describe user-visible behavior. Pull requests should include a concise summary, test results, any environment/configuration changes, and linked issues when applicable. Include request/response examples when API behavior changes.

## Security & Configuration Tips

Do not commit real MongoDB credentials or production license data. Store `MONGODB_URI` in the local shell or deployment environment. Be careful when changing CORS, rate-limit settings, validation counters, or hashing behavior because those affect API exposure and license enforcement.
