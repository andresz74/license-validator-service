# License Validator Service

Node.js/Express API for activating and validating software license keys stored in MongoDB. Runtime license checks use the `licenseDatabase.licenses` collection; `licenses.json` is sample data only and is not read by the application.

## Endpoints

### `GET /health`

Reports MongoDB readiness.

Success:

```json
{
  "status": "ok",
  "mongoConnected": true
}
```

When MongoDB is not ready, the endpoint returns `503` with `mongoConnected: false`.

### `POST /activate-license`

Preferred endpoint for the Photoshop plugin. Use activation when a device/install claims a license slot. Repeated activation from the same `deviceId` reuses the existing activation and does not consume another slot.

```bash
curl -X POST http://localhost:3000/activate-license \
  -H "Content-Type: application/json" \
  -d '{"key":"example-license-key","deviceId":"stable-device-hash","pluginVersion":"1.0.0"}'
```

Success:

```json
{
  "message": "OK",
  "activationId": "act_...",
  "activationToken": "<hash>",
  "activated": true
}
```

Existing device success also includes `"reused": true`.

### `POST /validate-license`

Backward-compatible validation endpoint. New Photoshop plugin code should use `POST /activate-license`; this endpoint remains available for older clients that only send a license key.

```bash
curl -X POST http://localhost:3000/validate-license \
  -H "Content-Type: application/json" \
  -d '{"key":"example-license-key"}'
```

Success:

```json
{
  "message": "OK",
  "validationString": "<hash>"
}
```

### `GET /validate-license?key=<licenseId>`

Deprecated but temporarily supported for backward compatibility. GET responses include deprecation headers. Do not send license keys in URLs for new integrations.

## Error Responses

- `400`: missing or invalid key, for example `{"message":"License key is required","code":"MISSING_LICENSE_KEY"}` or `{"message":"Invalid license key","code":"INVALID_LICENSE_KEY"}`.
- `400`: missing or invalid activation metadata, such as `{"message":"Device ID is required","code":"MISSING_DEVICE_ID"}` or `{"message":"Invalid plugin version","code":"INVALID_PLUGIN_VERSION"}`.
- `403`: unknown license, `{"message":"Invalid license key","code":"LICENSE_NOT_FOUND"}`.
- `403`: inactive license, `{"message":"License is not active","code":"LICENSE_NOT_ACTIVE"}`.
- `429`: validation limit reached, `{"message":"Validation limit reached","code":"VALIDATION_LIMIT_REACHED"}`.
- `429`: activation limit reached, `{"message":"No more activations","code":"ACTIVATION_LIMIT_REACHED"}`.
- `429`: request rate limit reached, returned by `express-rate-limit`.
- `503`: database not ready, `{"message":"Database not ready","code":"DATABASE_NOT_READY"}`.
- `500`: malformed license document, `{"message":"License validation failed","code":"LICENSE_DOCUMENT_INVALID"}`.
- `500`: unexpected validation/update/configuration failure, such as `{"message":"Internal Server Error","code":"INTERNAL_SERVER_ERROR"}`, `{"message":"Internal Server Error","code":"LICENSE_UPDATE_FAILED"}`, or `{"message":"Internal Server Error","code":"SERVER_CONFIGURATION_ERROR"}`.

## Environment Variables

| Variable | Required | Default | Example | Controls |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | Yes for startup/deploy | None | `mongodb+srv://user:pass@cluster.example.net` | MongoDB connection. |
| `HMAC_SECRET` | Yes for startup/deploy | None | `replace-with-a-long-random-secret` | Server-side HMAC key for validation strings. |
| `PORT` | No | `3000` | `3000` | Local server port for `npm start`. |
| `ALLOWED_ORIGINS` | No | No browser CORS origins | `https://example.com,https://app.example.com` | Comma-separated browser origins allowed by CORS. |
| `RATE_LIMIT_WINDOW_MS` | No | `900000` | `900000` | Validation rate-limit window. |
| `RATE_LIMIT_MAX` | No | `100` | `100` | Validation requests allowed per window per IP. |
| `TRUST_PROXY` | No | auto-enabled on Vercel; otherwise unset/false | `true` | Enables `app.set("trust proxy", 1)` behind trusted proxies. |
| `VERCEL` | Set by Vercel | unset | `1` | Platform marker used to enable trusted proxy handling on Vercel. |
| `NODE_ENV` | No | unset | `production` | Standard Node environment label; current CORS behavior is controlled by `ALLOWED_ORIGINS`. |

## MongoDB Setup

The service uses database `licenseDatabase` and collection `licenses`.

Create a unique index so each key maps to one document:

```js
db.licenses.createIndex({ licenseId: 1 }, { unique: true })
```

Recommended activation document shape:

```js
{
  licenseId: "example-license-key",
  status: "active",
  maxActivations: 3,
  activations: [
    {
      activationId: "act_...",
      deviceId: "stable-device-hash",
      activationToken: "hash",
      pluginVersion: "1.0.0",
      activatedAt: "2026-06-14T00:00:00.000Z",
      lastSeenAt: "2026-06-14T00:00:00.000Z"
    }
  ]
}
```

For activation records, missing `status` is treated as `"active"`, missing `maxActivations` is treated as `3`, and missing `activations` is treated as an empty array. If present, `status` must be `active`, `revoked`, or `disabled`; only `active` licenses can activate. `maxActivations` must be a non-negative integer and `activations` must be an array of valid activation objects.

Legacy validation fields are still supported for backward-compatible validation endpoints:

```js
{
  licenseId: "example-license-key",
  validationNumber: 0,
  validationStrings: [],
  saltStrings: []
}
```

For legacy records, `validationNumber`, `validationStrings`, and `saltStrings` may be omitted; validation treats an omitted `validationNumber` as `0` and creates omitted arrays when the license is validated. If those fields exist, they must have the expected types: `validationNumber` must be a non-negative integer, and `validationStrings` and `saltStrings` must be arrays of strings. License validation increments `validationNumber` atomically with MongoDB and stores generated validation strings and salts in the arrays.

## Terminology

- Activation: a Photoshop plugin device/install claims one license slot with `key`, `deviceId`, and optional `pluginVersion`.
- Validation: older compatibility flow that accepts only a license key.
- Activation token: a server-generated activation receipt the plugin can store locally; it is not a complete DRM system by itself.

## Local Development

```bash
npm install
export MONGODB_URI="mongodb+srv://user:pass@cluster.example.net"
export HMAC_SECRET="replace-with-a-long-random-secret"
npm start
```

Run tests:

```bash
npm test
```

There are no lint or typecheck scripts configured.

## Deployment Notes

The app supports local long-running server mode with `npm start` and Vercel/serverless import through `index.js`. Do not call `app.listen()` in serverless mode; the exported Express app is used by the platform.

CORS is handled by the Express app. Set `ALLOWED_ORIGINS` in production instead of using wildcard static headers. Requests without an `Origin` header still work for server-to-server clients and `curl`.

Rate limiting applies to `POST /activate-license`, `POST /validate-license`, and deprecated `GET /validate-license`; `/health` is not rate-limited. The default in-memory limiter is best-effort in serverless environments because each instance has separate memory. Trusted proxy handling is enabled automatically on Vercel. Use `TRUST_PROXY=true` on other trusted hosted/proxy platforms so client IP handling works correctly.

## Security Notes

- Prefer `POST /activate-license` for the Photoshop plugin; do not send license keys in URLs for new clients.
- Keep `HMAC_SECRET` private and rotate it carefully because it signs validation strings and activation tokens.
- The plugin must not contain `HMAC_SECRET`.
- Send a stable hashed `deviceId`, not sensitive raw personal data.
- Treat activation tokens as activation receipts; add server-side check/revocation endpoints later if the plugin needs ongoing license enforcement.
- Do not commit production MongoDB credentials, HMAC secrets, or production license data.
- Restrict `ALLOWED_ORIGINS` to trusted browser clients in production.
- Treat in-memory rate limiting as best-effort in serverless deployments.

## Sample Data

`licenses.json` contains fake sample license documents that match the expected MongoDB shape. It is not used by the runtime service.

## License

Distributed under the MIT License. See `LICENSE` for details.
