# Repository Guidelines

## Project Structure & Module Organization

This is a small Node.js/Express license activation and validation API. The main application lives in `index.js`, exports an Express app for serverless use, and exposes `createApp` for tests. Tests are in `__tests__/app.test.js` and use Jest with Supertest. `vercel.json` contains Vercel routing only; CORS is handled in the app. `licenses.json` is fake sample data and is not read at runtime.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm start`: run `node index.js` locally on `PORT` or `3000`.
- `npm test`: run the Jest/Supertest suite.

Local startup requires `MONGODB_URI` and `HMAC_SECRET`:

```bash
export MONGODB_URI="mongodb+srv://user:pass@cluster.example.net"
export HMAC_SECRET="replace-with-a-long-random-secret"
npm start
```

## API And Runtime Notes

Use `POST /activate-license` with JSON body `{ "key": "...", "deviceId": "...", "pluginVersion": "..." }` for new Photoshop plugin code. Keep `POST /validate-license` for backward compatibility. `GET /validate-license?key=...` is deprecated but must not be removed without explicit approval. `GET /health` reports MongoDB readiness.

License validation must stay atomic: enforce the validation limit in MongoDB with `findOneAndUpdate`, `$inc`, and `$push`. Do not reintroduce read-then-write validation count logic. Legacy license documents may omit `validationNumber`, `validationStrings`, or `saltStrings`; existing values for those fields must have the expected number/array types and malformed documents should fail with a controlled server error.

Activation logic must also stay atomic. Same-device reactivation must reuse the existing activation and must not consume another slot. New-device activation must only append an activation record when the license is active and the current activation count is below `maxActivations`. Legacy activation records may omit `status`, `maxActivations`, or `activations`; existing values must have the documented types and malformed documents should fail safely.

## Coding Style & Naming Conventions

Use CommonJS modules and 2-space indentation. Keep response bodies structured with stable `message` and `code` fields for errors. Keep this service compact unless a change clearly justifies new modules.

## Testing Guidelines

Route tests should use `createApp` with injected fake collections/readiness behavior. Do not require real MongoDB for Jest tests. Add or update tests when changing routes, response codes, CORS, rate limiting, MongoDB update behavior, or environment handling. Run `npm test` before finishing.

## Commit & Pull Request Guidelines

Keep commits focused and imperative, such as `Add POST license validation`. Pull requests should include a concise summary, test results, and any environment/deployment notes. Include request/response examples when API behavior changes.

## Security & Configuration Tips

Do not commit secrets, real MongoDB credentials, or production license data. Required runtime env vars are `MONGODB_URI` and `HMAC_SECRET`; optional HTTP/deployment vars include `ALLOWED_ORIGINS`, `ALLOW_NULL_ORIGIN`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `TRUST_PROXY`, `PORT`, and `NODE_ENV`. Adobe/plugin runtimes may send `Origin: null`; only enable that with `ALLOW_NULL_ORIGIN=true` when needed. Do not treat CORS as the licensing security boundary. Restrict browser origins in production and treat in-memory rate limiting as best-effort in serverless environments. Never put backend secrets in Photoshop plugin code; device IDs should be stable opaque hashes rather than sensitive raw personal data.
