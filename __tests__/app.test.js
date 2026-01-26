const request = require("supertest");
const { createApp } = require("../index");

const noRateLimit = (req, res, next) => next();

describe("license validator service", () => {
  test("health reports MongoDB readiness", async () => {
    const app = createApp({
      getMongoConnected: () => false,
      rateLimiter: noRateLimit,
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "ok", mongoConnected: false });
  });

  test("validates a license and returns a validation string", async () => {
    const license = {
      licenseId: "abc123",
      validationNumber: 0,
      validationStrings: [],
      saltStrings: [],
    };

    const collection = {
      findOne: jest.fn().mockResolvedValue(license),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    };

    const app = createApp({
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
    expect(collection.updateOne).toHaveBeenCalled();
  });

  test("returns structured error for missing license", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const app = createApp({
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
    };

    const app = createApp({
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

  test("returns structured error when database not ready", async () => {
    const app = createApp({
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
