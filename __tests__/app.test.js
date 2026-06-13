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

  test("returns structured error when license key is missing", async () => {
    const collection = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    const app = createApp({
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

    const app = createApp({
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

    const app = createApp({
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

    const app = createApp({
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

  test("validates a license with an atomic update and returns a validation string", async () => {
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
    expect(collection.findOne).not.toHaveBeenCalled();
  });

  test("returns structured error for missing license", async () => {
    const collection = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
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

    const app = createApp({
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

    const app = createApp({
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
