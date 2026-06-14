const {
  buildLicenseDocument,
  generateLicenseKey,
  insertLicenseWithRetry,
  loadDotEnv,
  parseDotEnvLine,
  parseCreateLicenseArgs,
  run,
} = require("../scripts/createLicense");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("create license script helpers", () => {
  test("generates readable Photoshop license keys", () => {
    const licenseKey = generateLicenseKey({ prefix: "PSP" });

    expect(licenseKey).toMatch(
      /^PSP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/
    );
    expect(licenseKey).not.toMatch(/[O0I1]/);
  });

  test("parses default create license options", () => {
    expect(parseCreateLicenseArgs([])).toEqual({
      maxActivations: 3,
      source: "script",
      prefix: "PSP",
    });
  });

  test("parses dotenv lines", () => {
    expect(parseDotEnvLine("MONGODB_URI=mongodb://example")).toEqual({
      key: "MONGODB_URI",
      value: "mongodb://example",
    });
    expect(parseDotEnvLine("HMAC_SECRET=\"quoted-secret\"")).toEqual({
      key: "HMAC_SECRET",
      value: "quoted-secret",
    });
    expect(parseDotEnvLine("# ignored")).toBeNull();
  });

  test("loads dotenv values without overriding exported variables", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "license-env-"));
    const filePath = path.join(directory, ".env");
    const env = {
      MONGODB_URI: "mongodb://exported",
    };

    fs.writeFileSync(
      filePath,
      [
        "MONGODB_URI=mongodb://from-file",
        "MONGODB_DATABASE=licenseDatabase",
      ].join("\n")
    );

    loadDotEnv({ env, filePath });

    expect(env).toEqual({
      MONGODB_URI: "mongodb://exported",
      MONGODB_DATABASE: "licenseDatabase",
    });
  });

  test("parses explicit create license options", () => {
    expect(
      parseCreateLicenseArgs([
        "--max-activations",
        "1",
        "--source",
        "manual",
        "--prefix",
        "psx",
      ])
    ).toEqual({
      maxActivations: 1,
      source: "manual",
      prefix: "PSX",
    });
  });

  test("rejects invalid max activations", () => {
    expect(() =>
      parseCreateLicenseArgs(["--max-activations", "0"])
    ).toThrow("--max-activations must be a positive integer.");
  });

  test("builds activation-model license documents", () => {
    const license = buildLicenseDocument({
      licenseId: "PSP-K7M9-Q2XA-84PD",
      maxActivations: 2,
      source: "manual",
      now: new Date("2026-06-14T00:00:00.000Z"),
    });

    expect(license).toEqual({
      licenseId: "PSP-K7M9-Q2XA-84PD",
      status: "active",
      maxActivations: 2,
      activations: [],
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      source: "manual",
    });
    expect(license).not.toHaveProperty("validationNumber");
    expect(license).not.toHaveProperty("validationStrings");
    expect(license).not.toHaveProperty("saltStrings");
  });

  test("retries duplicate license keys", async () => {
    const duplicateError = new Error("duplicate key");
    duplicateError.code = 11000;
    const collection = {
      insertOne: jest
        .fn()
        .mockRejectedValueOnce(duplicateError)
        .mockResolvedValueOnce({ acknowledged: true }),
    };

    const license = await insertLicenseWithRetry({
      collection,
      prefix: "PSP",
      maxActivations: 3,
      source: "script",
      attempts: 2,
    });

    expect(collection.insertOne).toHaveBeenCalledTimes(2);
    expect(license.licenseId).toMatch(
      /^PSP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/
    );
  });

  test("missing MONGODB_URI exits with a clear error", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    await run({
      args: [],
      env: {},
      dotEnvFilePath: path.join(os.tmpdir(), "missing-license-env-file"),
      MongoClientClass: jest.fn(),
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Missing required environment variable MONGODB_URI."
    );
    expect(process.exitCode).toBe(1);

    process.exitCode = originalExitCode;
    consoleErrorSpy.mockRestore();
  });
});
