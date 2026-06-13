# license-validator-service
---

# License Validator

## About

License Validator is a simple Node.js application built with Express.js. It provides an API endpoint to validate license keys against a predefined list of valid licenses. This project is useful for software that requires license key validation.

## Features

- Validate license keys via an API endpoint.
- Easy integration with existing systems.
- Simple and straightforward setup.

## Getting Started

### Prerequisites

- Node.js
- npm (Node Package Manager)
- MongoDB connection string available as `MONGODB_URI`
- HMAC signing secret available as `HMAC_SECRET`

### Installation

1. **Clone the Repository**
    ```bash
    git clone https://github.com/andresz74/license-validator-main.git
    cd license-validator-main
    ```

2. **Install Dependencies**
    ```bash
    npm install
    ```

3. **Set Up Environment Variables**
    - Define the MongoDB connection string and HMAC secret:
        ```bash
        export MONGODB_URI="mongodb+srv://user:pass@cluster.example.mongodb.net"
        export HMAC_SECRET="replace-with-a-long-random-secret"
        ```

### Running the Application

1. **Start the Server**
    ```bash
    npm start
    ```
    The server will start on `http://localhost:3000`.

2. **Access the Endpoint**
    - Validate a license key with `POST /validate-license`. New clients should not send license keys in URLs.

## MongoDB Collection

The service expects licenses in the `licenseDatabase.licenses` collection. Create a unique index on `licenseId` so each key maps to exactly one document and validation behavior is deterministic:

```js
db.licenses.createIndex({ licenseId: 1 }, { unique: true })
```

Expected document shape:

```js
{
  licenseId: "example-license-key",
  validationNumber: 0,
  validationStrings: [],
  saltStrings: []
}
```

## API Reference

### Validate License Endpoint

- **URL**
  
  `/validate-license`

- **Preferred Method:**

  `POST`

- **Request Body:**

  ```json
  {
    "key": "your_license_key"
  }
  ```

- **Deprecated Method:**
  
  `GET`
  
- **URL Params**

   **Required for GET only:**
 
   `key=[string]`

- **Deprecation Notice:**

  `GET /validate-license?key=...` remains temporarily supported for backward compatibility, but it is deprecated because license keys in URLs can appear in browser history, logs, analytics, proxies, CDNs, and referrers. GET responses include a deprecation header. Use POST for new integrations.

- **Success Response:**

  - **Code:** 200 <br />
    **Content:** `{"message":"OK","validationString":"<hash>"}`
 
- **Error Response:**

  - **Code:** 403 UNAUTHORIZED <br />
    **Content:** `{"message":"Invalid license key","code":"LICENSE_NOT_FOUND"}`

  - **Code:** 429 TOO MANY REQUESTS <br />
    **Content:** `{"message":"Validation limit reached","code":"VALIDATION_LIMIT_REACHED"}`

  - **Code:** 503 SERVICE UNAVAILABLE <br />
    **Content:** `{"message":"Database not ready","code":"DATABASE_NOT_READY"}`

### Environment Variables

- `MONGODB_URI`: required MongoDB connection string.
- `HMAC_SECRET`: required server-side secret used to sign validation strings.
- `PORT`: optional local port; defaults to `3000`.
- `ALLOWED_ORIGINS`: optional comma-separated browser origins allowed by CORS.
- `RATE_LIMIT_WINDOW_MS`: optional validation rate-limit window; defaults to `900000`.
- `RATE_LIMIT_MAX`: optional validation request limit per window; defaults to `100`.
- `TRUST_PROXY`: optional; set to `true` behind a trusted proxy or hosted platform so client IP handling works correctly.

### Health Endpoint

- **URL**
  
  `/health`

- **Method:**
  
  `GET`

- **Success Response:**

  - **Code:** 200 <br />
    **Content:** `{"status":"ok","mongoConnected":true}`

- **Error Response:**

  - **Code:** 503 SERVICE UNAVAILABLE <br />
    **Content:** `{"status":"ok","mongoConnected":false}`

## Rate Limiting

Requests to `POST /validate-license` and deprecated `GET /validate-license` are rate-limited. Defaults are 100 requests per 15 minutes per IP. `/health` is not rate-limited.

```bash
export RATE_LIMIT_WINDOW_MS=900000
export RATE_LIMIT_MAX=100
```

The default in-memory limiter is best-effort in serverless environments because each instance can have separate memory. Use `TRUST_PROXY=true` when the app runs behind a trusted proxy so Express and the limiter can use the correct client IP.

## CORS

Browser CORS access is controlled with `ALLOWED_ORIGINS`. When it is unset, the API does not emit broad browser CORS headers, but non-browser requests such as server-to-server calls and `curl` still work.

```bash
export ALLOWED_ORIGINS="https://example.com,https://app.example.com"
```

Avoid using wildcard origins for production license validation clients. If browser access is needed, list each trusted application origin explicitly.

## Deployment Notes

For local development, run `npm start` with `MONGODB_URI` and `HMAC_SECRET` set. On Vercel, configure `MONGODB_URI`, `HMAC_SECRET`, `ALLOWED_ORIGINS`, and `TRUST_PROXY=true` in the project environment. CORS is handled by the Express app, not by static `vercel.json` headers, so local and deployed behavior stay consistent.

## Contributing

Contributions to the License Validator project are welcome!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT License. See `LICENSE` file for more information.

## Contact

Andres Zenteno - [andres@zenteno.org](mailto:andres@zenteno.org)

Project Link: [https://github.com/andresz74/license-validator-main](https://github.com/andresz74/license-validator-main)
