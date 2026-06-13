const request = require("supertest");
const crypto = require("crypto");
const { createApp } = require("../index");

const noRateLimit = (req, res, next) => next();
const TEST_HMAC_SECRET = "test-hmac-secret";
const createTestApp = (options = {}) =>
  createApp({
    hmacSecret: TEST_HMAC_SECRET,
    ...options,
  });

describe("license validator service", () => {
  test("health reports MongoDB readiness", async () => {
    const app = createTestApp({
      getMongoConnected: () => false,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "ok", mongoConnected: false });
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
      findOne: jest.fn(),
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
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      {
        licenseId: "abc123",
        validationNumber: { $lt: 3 },
      },
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
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  test("POST validates a license with the shared atomic update flow", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 1,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn(),
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
      {
        licenseId: "abc123",
        validationNumber: { $lt: 3 },
      },
      expect.objectContaining({
        $inc: { validationNumber: 1 },
        $push: {
          validationStrings: response.body.validationString,
          saltStrings: expect.any(String),
        },
      }),
      { returnDocument: "after" }
    );
    expect(collection.findOne).not.toHaveBeenCalled();
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
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
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
  });

  test("POST returns structured error when validation limit reached", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 3,
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
      .post("/validate-license")
      .send({ key: "abc123" });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      message: "Validation limit reached",
      code: "VALIDATION_LIMIT_REACHED",
    });
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
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
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
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      {
        licenseId: "missing",
        validationNumber: { $lt: 3 },
      },
      expect.objectContaining({
        $inc: { validationNumber: 1 },
        $push: expect.any(Object),
      }),
      { returnDocument: "after" }
    );
    expect(collection.findOne).toHaveBeenCalledWith({ licenseId: "missing" });
  });

  test("returns structured error when validation limit reached", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 3,
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

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      message: "Validation limit reached",
      code: "VALIDATION_LIMIT_REACHED",
    });
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

  test("returns structured error when MongoDB update throws", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const collection = {
      findOneAndUpdate: jest.fn().mockRejectedValue(new Error("write failed")),
      findOne: jest.fn(),
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
    expect(collection.findOne).not.toHaveBeenCalled();

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
