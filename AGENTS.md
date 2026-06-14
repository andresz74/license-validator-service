# Repository Guidelines

## Project Structure & Module Organization

This is a small Node.js/Express license validation API. The main application lives in `index.js`, exports an Express app for serverless use, and exposes `createApp` for tests. Tests are in `__tests__/app.test.js` and use Jest with Supertest. `vercel.json` contains Vercel routing only; CORS is handled in the app. `licenses.json` is fake sample data and is not read at runtime.

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

Use `POST /validate-license` with JSON body `{ "key": "..." }` for new clients. `GET /validate-license?key=...` is deprecated but kept for backward compatibility. `GET /health` reports MongoDB readiness.

License validation must stay atomic: enforce the validation limit in MongoDB with `findOneAndUpdate`, `$inc`, and `$push`. Do not reintroduce read-then-write validation count logic. Legacy license documents may omit `validationNumber`, `validationStrings`, or `saltStrings`; existing values for those fields must have the expected number/array types and malformed documents should fail with a controlled server error.

## Coding Style & Naming Conventions

Use CommonJS modules and 2-space indentation. Keep response bodies structured with stable `message` and `code` fields for errors. Keep this service compact unless a change clearly justifies new modules.

## Testing Guidelines

Route tests should use `createApp` with injected fake collections/readiness behavior. Do not require real MongoDB for Jest tests. Add or update tests when changing routes, response codes, CORS, rate limiting, MongoDB update behavior, or environment handling. Run `npm test` before finishing.

## Commit & Pull Request Guidelines

Keep commits focused and imperative, such as `Add POST license validation`. Pull requests should include a concise summary, test results, and any environment/deployment notes. Include request/response examples when API behavior changes.

## Security & Configuration Tips

Do not commit secrets, real MongoDB credentials, or production license data. Required runtime env vars are `MONGODB_URI` and `HMAC_SECRET`; optional HTTP/deployment vars include `ALLOWED_ORIGINS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `TRUST_PROXY`, `PORT`, and `NODE_ENV`. Restrict browser origins in production and treat in-memory rate limiting as best-effort in serverless environments.
