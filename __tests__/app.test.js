const request = require("supertest");
const crypto = require("crypto");
const exportedApp = require("../index");

const { createApp } = exportedApp;

const noRateLimit = (req, res, next) => next();
const TEST_HMAC_SECRET = "test-hmac-secret";
const createTestApp = (options = {}) =>
  createApp({
    hmacSecret: TEST_HMAC_SECRET,
    ...options,
  });
const atomicValidationFilter = (licenseId) => ({
  licenseId,
  $or: [
    { validationNumber: { $lt: 3 } },
    { validationNumber: { $exists: false } },
  ],
});
const invalidDocumentBody = {
  message: "License validation failed",
  code: "LICENSE_DOCUMENT_INVALID",
};
const activeLicenseFilter = (licenseId) => ({
  licenseId,
  $or: [{ status: "active" }, { status: { $exists: false } }],
});
const existingActivationFilter = (licenseId, deviceId) => ({
  ...activeLicenseFilter(licenseId),
  activations: { $elemMatch: { deviceId } },
});
const newActivationFilter = (licenseId, deviceId) => ({
  ...activeLicenseFilter(licenseId),
  $nor: [{ activations: { $elemMatch: { deviceId } } }],
  $expr: {
    $lt: [
      { $size: { $ifNull: ["$activations", []] } },
      { $ifNull: ["$maxActivations", 3] },
    ],
  },
});
const existingActivation = {
  activationId: "act_existing",
  deviceId: "device-1",
  activationToken: "existing-token",
  pluginVersion: "1.0.0",
  activatedAt: "2026-06-14T00:00:00.000Z",
  lastSeenAt: "2026-06-14T00:00:00.000Z",
};

describe("license validator service", () => {
  test("exports an Express app for serverless usage while keeping createApp importable", () => {
    expect(typeof exportedApp).toBe("function");
    expect(typeof createApp).toBe("function");
  });

  test("health reports MongoDB readiness", async () => {
    const app = createTestApp({
      getMongoConnected: () => false,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "ok", mongoConnected: false });
  });

  test("health is not rate limited", async () => {
    const app = createTestApp({
      getMongoConnected: () => true,
      rateLimitOptions: { windowMs: 60 * 1000, limit: 1 },
    });

    const firstResponse = await request(app).get("/health");
    const secondResponse = await request(app).get("/health");

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
  });

  test("allows configured CORS origins", async () => {
    const app = createTestApp({
      allowedOrigins: ["https://app.example.com"],
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/health")
      .set("Origin", "https://app.example.com");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );
  });

  test("does not emit permissive CORS headers for disallowed origins", async () => {
    const app = createTestApp({
      allowedOrigins: ["https://app.example.com"],
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.com");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("requests without Origin still work", async () => {
    const app = createTestApp({
      allowedOrigins: ["https://app.example.com"],
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("does not allow null Origin unless explicitly enabled", async () => {
    const app = createTestApp({
      allowedOrigins: ["https://app.example.com"],
      allowNullOrigin: false,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/health").set("Origin", "null");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("allows null Origin when explicitly enabled", async () => {
    const app = createTestApp({
      allowNullOrigin: true,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/health").set("Origin", "null");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("null");
  });

  test("allows null Origin activation preflight when explicitly enabled", async () => {
    const app = createTestApp({
      allowNullOrigin: true,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .options("/activate-license")
      .set("Origin", "null")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("null");
  });

  test("trust proxy can be enabled through app config", () => {
    const app = createTestApp({
      trustProxy: true,
      rateLimiter: noRateLimit,
    });

    expect(app.get("trust proxy")).toBe(1);
  });

  test("trust proxy is enabled automatically on Vercel", async () => {
    const originalVercel = process.env.VERCEL;
    process.env.VERCEL = "1";

    try {
      const app = createTestApp({
        getMongoConnected: () => true,
        rateLimitOptions: { windowMs: 60 * 1000, limit: 10 },
      });

      expect(app.get("trust proxy")).toBe(1);

      const response = await request(app)
        .post("/validate-license")
        .set("X-Forwarded-For", "203.0.113.10")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      });
    } finally {
      if (originalVercel === undefined) {
        delete process.env.VERCEL;
      } else {
        process.env.VERCEL = originalVercel;
      }
    }
  });

  test.each([
    [
      "missing key",
      { deviceId: "device-1" },
      {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    ],
    [
      "empty key",
      { key: "", deviceId: "device-1" },
      {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    ],
    [
      "whitespace key",
      { key: "   ", deviceId: "device-1" },
      {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    ],
    [
      "non-string key",
      { key: 123, deviceId: "device-1" },
      {
        message: "Invalid license key",
        code: "INVALID_LICENSE_KEY",
      },
    ],
    [
      "missing deviceId",
      { key: "abc123" },
      {
        message: "Device ID is required",
        code: "MISSING_DEVICE_ID",
      },
    ],
    [
      "empty deviceId",
      { key: "abc123", deviceId: "" },
      {
        message: "Device ID is required",
        code: "MISSING_DEVICE_ID",
      },
    ],
    [
      "whitespace deviceId",
      { key: "abc123", deviceId: "   " },
      {
        message: "Device ID is required",
        code: "MISSING_DEVICE_ID",
      },
    ],
    [
      "non-string deviceId",
      { key: "abc123", deviceId: 123 },
      {
        message: "Invalid device ID",
        code: "INVALID_DEVICE_ID",
      },
    ],
    [
      "non-string pluginVersion",
      { key: "abc123", deviceId: "device-1", pluginVersion: 123 },
      {
        message: "Invalid plugin version",
        code: "INVALID_PLUGIN_VERSION",
      },
    ],
  ])("POST /activate-license returns 400 for %s", async (_, body, expected) => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).post("/activate-license").send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expected);
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("POST /activate-license creates a new activation atomically", async () => {
    const license = {
      licenseId: "abc123",
      status: "active",
      maxActivations: 3,
      activations: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockImplementationOnce((filter, update) =>
          Promise.resolve({
            ...license,
            activations: [update.$push.activations],
          })
        ),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({
        key: "abc123",
        deviceId: "device-1",
        pluginVersion: "1.0.0",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: "OK",
      activationId: expect.stringMatching(/^act_[a-f0-9]{24}$/),
      activationToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      activated: true,
    });
    expect(collection.findOne).toHaveBeenCalledWith({ licenseId: "abc123" });
    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      existingActivationFilter("abc123", "device-1"),
      {
        $set: {
          "activations.$.lastSeenAt": expect.any(String),
          "activations.$.pluginVersion": "1.0.0",
        },
      },
      { returnDocument: "after" }
    );
    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      newActivationFilter("abc123", "device-1"),
      {
        $push: {
          activations: {
            activationId: response.body.activationId,
            deviceId: "device-1",
            activationToken: response.body.activationToken,
            pluginVersion: "1.0.0",
            activatedAt: expect.any(String),
            lastSeenAt: expect.any(String),
          },
        },
      },
      { returnDocument: "after" }
    );
  });

  test("POST /activate-license supports legacy license defaults", async () => {
    const legacyLicense = { licenseId: "legacy-key" };
    const collection = {
      findOne: jest.fn().mockResolvedValue(legacyLicense),
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockImplementationOnce((filter, update) =>
          Promise.resolve({
            ...legacyLicense,
            activations: [update.$push.activations],
          })
        ),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({ key: "legacy-key", deviceId: "device-1" });

    expect(response.status).toBe(200);
    expect(response.body.activated).toBe(true);
    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      newActivationFilter("legacy-key", "device-1"),
      expect.objectContaining({
        $push: {
          activations: expect.objectContaining({
            deviceId: "device-1",
          }),
        },
      }),
      { returnDocument: "after" }
    );
  });

  test("POST /activate-license reuses an existing device activation", async () => {
    const license = {
      licenseId: "abc123",
      status: "active",
      maxActivations: 1,
      activations: [existingActivation],
    };
    const updatedLicense = {
      ...license,
      activations: [
        {
          ...existingActivation,
          pluginVersion: "1.1.0",
          lastSeenAt: "2026-06-14T01:00:00.000Z",
        },
      ],
    };
    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn().mockResolvedValueOnce(updatedLicense),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({
        key: "abc123",
        deviceId: "device-1",
        pluginVersion: "1.1.0",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: "OK",
      activationId: "act_existing",
      activationToken: "existing-token",
      activated: true,
      reused: true,
    });
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      existingActivationFilter("abc123", "device-1"),
      {
        $set: {
          "activations.$.lastSeenAt": expect.any(String),
          "activations.$.pluginVersion": "1.1.0",
        },
      },
      { returnDocument: "after" }
    );
  });

  test("POST /activate-license returns 429 when activation slots are full", async () => {
    const license = {
      licenseId: "abc123",
      status: "active",
      maxActivations: 1,
      activations: [existingActivation],
    };
    const collection = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(license)
        .mockResolvedValueOnce(license),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({ key: "abc123", deviceId: "device-2" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      message: "No more activations",
      code: "ACTIVATION_LIMIT_REACHED",
    });
    expect(collection.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      newActivationFilter("abc123", "device-2"),
      expect.objectContaining({ $push: { activations: expect.any(Object) } }),
      { returnDocument: "after" }
    );
  });

  test.each(["revoked", "disabled"])(
    "POST /activate-license rejects %s licenses",
    async (status) => {
      const collection = {
        findOne: jest.fn().mockResolvedValue({
          licenseId: "abc123",
          status,
          activations: [],
        }),
        findOneAndUpdate: jest.fn(),
      };

      const app = createTestApp({
        getLicensesCollection: () => collection,
        getMongoConnected: () => true,
        rateLimiter: noRateLimit,
      });

      const response = await request(app)
        .post("/activate-license")
        .send({ key: "abc123", deviceId: "device-1" });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        message: "License is not active",
        code: "LICENSE_NOT_ACTIVE",
      });
      expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  test.each([
    ["invalid status", { status: "pending", activations: [] }],
    ["non-number maxActivations", { maxActivations: "three", activations: [] }],
    ["negative maxActivations", { maxActivations: -1, activations: [] }],
    ["non-array activations", { activations: "not-an-array" }],
    [
      "malformed activation entry",
      {
        activations: [
          {
            activationId: "act_bad",
            deviceId: "",
            activationToken: "token",
          },
        ],
      },
    ],
  ])("POST /activate-license returns controlled error for %s", async (_, fields) => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({
        licenseId: "bad-key",
        ...fields,
      }),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({ key: "bad-key", deviceId: "device-1" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual(invalidDocumentBody);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("POST /activate-license returns 403 for unknown licenses", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({ key: "missing", deviceId: "device-1" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      message: "Invalid license key",
      code: "LICENSE_NOT_FOUND",
    });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("POST /activate-license returns 503 when database is not ready", async () => {
    const app = createTestApp({
      getLicensesCollection: () => null,
      getMongoConnected: () => false,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/activate-license")
      .send({ key: "abc123", deviceId: "device-1" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: "Database not ready",
      code: "DATABASE_NOT_READY",
    });
  });

  test("POST /activate-license is rate limited with configurable limits", async () => {
    const app = createTestApp({
      getMongoConnected: () => true,
      rateLimitOptions: { windowMs: 60 * 1000, limit: 1 },
    });

    const firstResponse = await request(app)
      .post("/activate-license")
      .send({});
    const secondResponse = await request(app)
      .post("/activate-license")
      .send({});

    expect(firstResponse.status).toBe(400);
    expect(secondResponse.status).toBe(429);
  });

  test("returns structured error when license key is missing", async () => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/validate-license");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: "License key is required",
      code: "MISSING_LICENSE_KEY",
    });
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("returns structured error when license key is empty", async () => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: "License key is required",
      code: "MISSING_LICENSE_KEY",
    });
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("returns structured error when license key is whitespace only", async () => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "   " });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: "License key is required",
      code: "MISSING_LICENSE_KEY",
    });
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("returns structured error when license key is not a simple string", async () => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get(
      "/validate-license?key=abc123&key=def456"
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      message: "Invalid license key",
      code: "INVALID_LICENSE_KEY",
    });
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("GET validates a license with an atomic update and returns a validation string", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 1,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn().mockResolvedValue(license),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("OK");
    expect(response.body.validationString).toBeTruthy();
    expect(response.headers.deprecation).toBe("true");
    expect(response.headers.warning).toBe(
      '299 - "GET /validate-license is deprecated; use POST /validate-license"'
    );
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      atomicValidationFilter("abc123"),
      {
        $inc: { validationNumber: 1 },
        $push: {
          validationStrings: response.body.validationString,
          saltStrings: expect.any(String),
        },
      },
      { returnDocument: "after" }
    );

    const update = collection.findOneAndUpdate.mock.calls[0][1];
    const salt = update.$push.saltStrings;
    const expectedValidationString = crypto
      .createHmac("sha256", TEST_HMAC_SECRET)
      .update(`abc123:${salt}`)
      .digest("hex");
    expect(response.body.validationString).toBe(expectedValidationString);
    expect(response.body.validationString).toMatch(/^[a-f0-9]{64}$/);
    expect(collection.findOne).toHaveBeenCalledWith({ licenseId: "abc123" });
  });

  test("POST validates a license with the shared atomic update flow", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 1,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn().mockResolvedValue(license),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/validate-license")
      .send({ key: "abc123" });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("OK");
    expect(response.body.validationString).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.deprecation).toBeUndefined();
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      atomicValidationFilter("abc123"),
      expect.objectContaining({
        $inc: { validationNumber: 1 },
        $push: {
          validationStrings: response.body.validationString,
          saltStrings: expect.any(String),
        },
      }),
      { returnDocument: "after" }
    );
    expect(collection.findOne).toHaveBeenCalledWith({ licenseId: "abc123" });
  });

  test("POST returns structured error when HMAC secret is not configured", async () => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      hmacSecret: "",
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/validate-license")
      .send({ key: "abc123" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      message: "Internal Server Error",
      code: "SERVER_CONFIGURATION_ERROR",
    });
    expect(collection.findOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each([
    ["validationNumber", { licenseId: "legacy-key", validationStrings: [], saltStrings: [] }],
    ["validationStrings", { licenseId: "legacy-key", validationNumber: 0, saltStrings: [] }],
    ["saltStrings", { licenseId: "legacy-key", validationNumber: 0, validationStrings: [] }],
  ])(
    "POST validates legacy license missing %s",
    async (_, legacyLicense) => {
      const collection = {
        findOne: jest.fn().mockResolvedValue(legacyLicense),
        findOneAndUpdate: jest.fn().mockResolvedValue({
          ...legacyLicense,
          validationNumber: 1,
        }),
      };

      const app = createTestApp({
        getLicensesCollection: () => collection,
        getMongoConnected: () => true,
        rateLimiter: noRateLimit,
      });

      const response = await request(app)
        .post("/validate-license")
        .send({ key: "legacy-key" });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe("OK");
      expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
        atomicValidationFilter("legacy-key"),
        expect.objectContaining({
          $inc: { validationNumber: 1 },
          $push: {
            validationStrings: response.body.validationString,
            saltStrings: expect.any(String),
          },
        }),
        { returnDocument: "after" }
      );
    }
  );

  test.each([
    ["non-number validationNumber", { validationNumber: "two", validationStrings: [], saltStrings: [] }],
    ["negative validationNumber", { validationNumber: -1, validationStrings: [], saltStrings: [] }],
    ["non-array validationStrings", { validationNumber: 0, validationStrings: "not-an-array", saltStrings: [] }],
    ["non-array saltStrings", { validationNumber: 0, validationStrings: [], saltStrings: null }],
  ])("POST returns controlled error for %s", async (_, fields) => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({
        licenseId: "bad-key",
        ...fields,
      }),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/validate-license")
      .send({ key: "bad-key" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual(invalidDocumentBody);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("POST /validate-license is rate limited with configurable limits", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 1,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn().mockResolvedValue(license),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimitOptions: { windowMs: 60 * 1000, limit: 1 },
    });

    const firstResponse = await request(app)
      .post("/validate-license")
      .send({ key: "abc123" });
    const secondResponse = await request(app)
      .post("/validate-license")
      .send({ key: "abc123" });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(429);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test("GET /validate-license is rate limited with configurable limits", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 1,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn().mockResolvedValue(license),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimitOptions: { windowMs: 60 * 1000, limit: 1 },
    });

    const firstResponse = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });
    const secondResponse = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(429);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "missing",
      {},
      {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    ],
    [
      "empty",
      { key: "" },
      {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    ],
    [
      "whitespace only",
      { key: "   " },
      {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    ],
    [
      "non-string",
      { key: 123 },
      {
        message: "Invalid license key",
        code: "INVALID_LICENSE_KEY",
      },
    ],
  ])(
    "POST returns structured error when license key is %s",
    async (_, body, expectedBody) => {
      const collection = {
        findOne: jest.fn(),
        findOneAndUpdate: jest.fn(),
      };

      const app = createTestApp({
        getLicensesCollection: () => collection,
        getMongoConnected: () => true,
        rateLimiter: noRateLimit,
      });

      const response = await request(app).post("/validate-license").send(body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(expectedBody);
      expect(collection.findOne).not.toHaveBeenCalled();
      expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  test("POST returns structured error for missing license", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/validate-license")
      .send({ key: "missing" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      message: "Invalid license key",
      code: "LICENSE_NOT_FOUND",
    });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("POST returns structured error when validation limit reached", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 3,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/validate-license")
      .send({ key: "abc123" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      message: "Validation limit reached",
      code: "VALIDATION_LIMIT_REACHED",
    });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("POST returns structured error when database not ready", async () => {
    const app = createTestApp({
      getLicensesCollection: () => null,
      getMongoConnected: () => false,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .post("/validate-license")
      .send({ key: "abc123" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: "Database not ready",
      code: "DATABASE_NOT_READY",
    });
  });

  test("returns structured error for missing license", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "missing" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      message: "Invalid license key",
      code: "LICENSE_NOT_FOUND",
    });
    expect(collection.findOne).toHaveBeenCalledWith({ licenseId: "missing" });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("returns structured error when validation limit reached", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 3,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      findOneAndUpdate: jest.fn(),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      message: "Validation limit reached",
      code: "VALIDATION_LIMIT_REACHED",
    });
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("returns safe error when atomic update does not apply below the limit", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 1,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(license),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      message: "Internal Server Error",
      code: "LICENSE_UPDATE_FAILED",
    });
  });

  test("returns controlled error when fallback lookup finds malformed document", async () => {
    const collection = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce({
          licenseId: "abc123",
          validationNumber: 1,
          validationStrings: [],
          saltStrings: [],
        })
        .mockResolvedValueOnce({
          licenseId: "abc123",
          validationNumber: "two",
          validationStrings: [],
          saltStrings: [],
        }),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual(invalidDocumentBody);
  });

  test("returns structured error when MongoDB update throws", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const collection = {
      findOneAndUpdate: jest.fn().mockRejectedValue(new Error("write failed")),
      findOne: jest.fn().mockResolvedValue({
        licenseId: "abc123",
        validationNumber: 1,
        validationStrings: [],
        saltStrings: [],
      }),
    };

    const app = createTestApp({
      getLicensesCollection: () => collection,
      getMongoConnected: () => true,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      message: "Internal Server Error",
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(collection.findOne).toHaveBeenCalledWith({ licenseId: "abc123" });

    consoleErrorSpy.mockRestore();
  });

  test("returns structured error when database not ready", async () => {
    const app = createTestApp({
      getLicensesCollection: () => null,
      getMongoConnected: () => false,
      rateLimiter: noRateLimit,
    });

    const response = await request(app)
      .get("/validate-license")
      .query({ key: "abc123" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: "Database not ready",
      code: "DATABASE_NOT_READY",
    });
  });
});
