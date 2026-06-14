const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");

const port = process.env.PORT || 3000;

const dbName = "licenseDatabase";
let licensesCollection;
let mongoConnected = false;
const maxConnectAttempts = 5;
const connectRetryDelayMs = 1000;
const DEFAULT_VALIDATION_LIMIT = 3;
const DEFAULT_LICENSE_STATUS = "active";
const DEFAULT_MAX_ACTIVATIONS = 3;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 100;
const ACTIVE_LICENSE_STATUSES = ["active", "revoked", "disabled"];

const parseAllowedOrigins = (value) => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const getPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getBoolean = (value) => value === true || value === "true";

const isVercelEnvironment = (value = process.env.VERCEL) =>
  value === "1" || getBoolean(value);

const shouldTrustProxy = () =>
  getBoolean(process.env.TRUST_PROXY) || isVercelEnvironment();

const createValidationRateLimiter = ({
  windowMs = getPositiveInteger(
    process.env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS
  ),
  limit = getPositiveInteger(process.env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
} = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
  });

const createCorsOptions = (
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
) => ({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, false);
      return;
    }

    callback(null, allowedOrigins.includes(origin) ? origin : false);
  },
});

const getValidLicenseKey = (key) => {
  if (key === undefined) {
    return {
      error: {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    };
  }

  if (typeof key !== "string") {
    return {
      error: {
        message: "Invalid license key",
        code: "INVALID_LICENSE_KEY",
      },
    };
  }

  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return {
      error: {
        message: "License key is required",
        code: "MISSING_LICENSE_KEY",
      },
    };
  }

  return { value: trimmedKey };
};

const getValidDeviceId = (deviceId) => {
  if (deviceId === undefined) {
    return {
      error: {
        message: "Device ID is required",
        code: "MISSING_DEVICE_ID",
      },
    };
  }

  if (typeof deviceId !== "string") {
    return {
      error: {
        message: "Invalid device ID",
        code: "INVALID_DEVICE_ID",
      },
    };
  }

  const trimmedDeviceId = deviceId.trim();
  if (!trimmedDeviceId) {
    return {
      error: {
        message: "Device ID is required",
        code: "MISSING_DEVICE_ID",
      },
    };
  }

  return { value: trimmedDeviceId };
};

const getValidPluginVersion = (pluginVersion) => {
  if (pluginVersion === undefined) {
    return {};
  }

  if (typeof pluginVersion !== "string") {
    return {
      error: {
        message: "Invalid plugin version",
        code: "INVALID_PLUGIN_VERSION",
      },
    };
  }

  return { value: pluginVersion.trim() || "unknown" };
};

const getFindOneAndUpdateDocument = (result) => {
  if (!result) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value;
  }

  return result;
};

const licenseDocumentInvalid = () => ({
  status: 500,
  body: {
    message: "License validation failed",
    code: "LICENSE_DOCUMENT_INVALID",
  },
});

const isMissingValue = (value) => value === undefined;

const isValidValidationNumber = (value) =>
  Number.isInteger(value) && value >= 0;

const isValidStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNonEmptyString = (value) => typeof value === "string" && value.trim();

const isValidActivation = (activation) => {
  if (!activation || typeof activation !== "object" || Array.isArray(activation)) {
    return false;
  }

  if (
    !isNonEmptyString(activation.activationId) ||
    !isNonEmptyString(activation.deviceId) ||
    !isNonEmptyString(activation.activationToken)
  ) {
    return false;
  }

  if (
    !isMissingValue(activation.pluginVersion) &&
    typeof activation.pluginVersion !== "string"
  ) {
    return false;
  }

  if (
    !isMissingValue(activation.activatedAt) &&
    typeof activation.activatedAt !== "string"
  ) {
    return false;
  }

  if (
    !isMissingValue(activation.lastSeenAt) &&
    typeof activation.lastSeenAt !== "string"
  ) {
    return false;
  }

  return true;
};

const getLicenseShapeError = (license) => {
  if (!isMissingValue(license.validationNumber)) {
    if (!isValidValidationNumber(license.validationNumber)) {
      return "validationNumber";
    }
  }

  if (!isMissingValue(license.validationStrings)) {
    if (!isValidStringArray(license.validationStrings)) {
      return "validationStrings";
    }
  }

  if (!isMissingValue(license.saltStrings)) {
    if (!isValidStringArray(license.saltStrings)) {
      return "saltStrings";
    }
  }

  return null;
};

const getActivationLicenseShapeError = (license) => {
  if (!isMissingValue(license.status)) {
    if (!ACTIVE_LICENSE_STATUSES.includes(license.status)) {
      return "status";
    }
  }

  if (!isMissingValue(license.maxActivations)) {
    if (!Number.isInteger(license.maxActivations) || license.maxActivations < 0) {
      return "maxActivations";
    }
  }

  if (!isMissingValue(license.activations)) {
    if (!Array.isArray(license.activations)) {
      return "activations";
    }

    if (!license.activations.every(isValidActivation)) {
      return "activations";
    }
  }

  return null;
};

const getLicenseStatus = (license) =>
  isMissingValue(license.status) ? DEFAULT_LICENSE_STATUS : license.status;

const getMaxActivations = (license) =>
  isMissingValue(license.maxActivations)
    ? DEFAULT_MAX_ACTIVATIONS
    : license.maxActivations;

const getActivations = (license) =>
  isMissingValue(license.activations) ? [] : license.activations;

const generateSalt = () => crypto.randomBytes(16).toString("hex");

const generateActivationId = () =>
  `act_${crypto.randomBytes(12).toString("hex")}`;

const generateValidationString = (licenseKey, salt, hmacSecret) =>
  crypto
    .createHmac("sha256", hmacSecret)
    .update(`${licenseKey}:${salt}`)
    .digest("hex");

const generateActivationToken = ({
  licenseKey,
  deviceId,
  activationId,
  salt,
  hmacSecret,
}) =>
  crypto
    .createHmac("sha256", hmacSecret)
    .update(`${licenseKey}:${deviceId}:${activationId}:${salt}`)
    .digest("hex");

const getActiveLicenseFilter = (licenseId) => ({
  licenseId,
  $or: [
    { status: DEFAULT_LICENSE_STATUS },
    { status: { $exists: false } },
  ],
});

const getExistingActivationFilter = (licenseId, deviceId) => ({
  ...getActiveLicenseFilter(licenseId),
  activations: { $elemMatch: { deviceId } },
});

const getNewActivationFilter = (licenseId, deviceId) => ({
  ...getActiveLicenseFilter(licenseId),
  $nor: [{ activations: { $elemMatch: { deviceId } } }],
  $expr: {
    $lt: [
      { $size: { $ifNull: ["$activations", []] } },
      { $ifNull: ["$maxActivations", DEFAULT_MAX_ACTIVATIONS] },
    ],
  },
});

const getActivationResponseBody = (activation, reused = false) => ({
  message: "OK",
  activationId: activation.activationId,
  activationToken: activation.activationToken,
  activated: true,
  ...(reused ? { reused: true } : {}),
});

const findActivationByDeviceId = (license, deviceId) =>
  getActivations(license).find(
    (activation) => activation.deviceId === deviceId
  );

const validateLicenseKey = async ({ key, collection, hmacSecret }) => {
  const { value: licenseToValidate, error: keyError } = getValidLicenseKey(key);

  if (keyError) {
    return { status: 400, body: keyError };
  }

  if (!collection) {
    return {
      status: 503,
      body: {
        message: "Database not ready",
        code: "DATABASE_NOT_READY",
      },
    };
  }

  if (!hmacSecret) {
    return {
      status: 500,
      body: {
        message: "Internal Server Error",
        code: "SERVER_CONFIGURATION_ERROR",
      },
    };
  }

  const existingLicense = await collection.findOne({
    licenseId: licenseToValidate,
  });

  if (!existingLicense) {
    return {
      status: 403,
      body: {
        message: "Invalid license key",
        code: "LICENSE_NOT_FOUND",
      },
    };
  }

  if (getLicenseShapeError(existingLicense)) {
    return licenseDocumentInvalid();
  }

  if (existingLicense.validationNumber >= DEFAULT_VALIDATION_LIMIT) {
    return {
      status: 429,
      body: {
        message: "Validation limit reached",
        code: "VALIDATION_LIMIT_REACHED",
      },
    };
  }

  const salt = generateSalt();
  const validationString = generateValidationString(
    licenseToValidate,
    salt,
    hmacSecret
  );

  const updateResult = await collection.findOneAndUpdate(
    {
      licenseId: licenseToValidate,
      $or: [
        { validationNumber: { $lt: DEFAULT_VALIDATION_LIMIT } },
        { validationNumber: { $exists: false } },
      ],
    },
    {
      $inc: { validationNumber: 1 },
      $push: {
        validationStrings: validationString,
        saltStrings: salt,
      },
    },
    { returnDocument: "after" }
  );

  const updatedLicense = getFindOneAndUpdateDocument(updateResult);

  if (!updatedLicense) {
    const fallbackLicense = await collection.findOne({
      licenseId: licenseToValidate,
    });

    if (!fallbackLicense) {
      return {
        status: 403,
        body: {
          message: "Invalid license key",
          code: "LICENSE_NOT_FOUND",
        },
      };
    }

    if (getLicenseShapeError(fallbackLicense)) {
      return licenseDocumentInvalid();
    }

    if (fallbackLicense.validationNumber >= DEFAULT_VALIDATION_LIMIT) {
      return {
        status: 429,
        body: {
          message: "Validation limit reached",
          code: "VALIDATION_LIMIT_REACHED",
        },
      };
    }

    return {
      status: 500,
      body: {
        message: "Internal Server Error",
        code: "LICENSE_UPDATE_FAILED",
      },
    };
  }

  return {
    status: 200,
    body: {
      message: "OK",
      validationString: validationString,
    },
  };
};

const activateLicense = async ({
  key,
  deviceId,
  pluginVersion,
  collection,
  hmacSecret,
}) => {
  const { value: licenseToActivate, error: keyError } = getValidLicenseKey(key);

  if (keyError) {
    return { status: 400, body: keyError };
  }

  const { value: validDeviceId, error: deviceIdError } =
    getValidDeviceId(deviceId);

  if (deviceIdError) {
    return { status: 400, body: deviceIdError };
  }

  const { value: validPluginVersion, error: pluginVersionError } =
    getValidPluginVersion(pluginVersion);

  if (pluginVersionError) {
    return { status: 400, body: pluginVersionError };
  }

  if (!collection) {
    return {
      status: 503,
      body: {
        message: "Database not ready",
        code: "DATABASE_NOT_READY",
      },
    };
  }

  if (!hmacSecret) {
    return {
      status: 500,
      body: {
        message: "Internal Server Error",
        code: "SERVER_CONFIGURATION_ERROR",
      },
    };
  }

  const existingLicense = await collection.findOne({
    licenseId: licenseToActivate,
  });

  if (!existingLicense) {
    return {
      status: 403,
      body: {
        message: "Invalid license key",
        code: "LICENSE_NOT_FOUND",
      },
    };
  }

  if (getActivationLicenseShapeError(existingLicense)) {
    return licenseDocumentInvalid();
  }

  if (getLicenseStatus(existingLicense) !== DEFAULT_LICENSE_STATUS) {
    return {
      status: 403,
      body: {
        message: "License is not active",
        code: "LICENSE_NOT_ACTIVE",
      },
    };
  }

  const now = new Date().toISOString();
  const existingActivationUpdate = {
    $set: {
      "activations.$.lastSeenAt": now,
      ...(validPluginVersion !== undefined
        ? { "activations.$.pluginVersion": validPluginVersion }
        : {}),
    },
  };

  const existingActivationResult = await collection.findOneAndUpdate(
    getExistingActivationFilter(licenseToActivate, validDeviceId),
    existingActivationUpdate,
    { returnDocument: "after" }
  );
  const existingActivationLicense = getFindOneAndUpdateDocument(
    existingActivationResult
  );

  if (existingActivationLicense) {
    const activation = findActivationByDeviceId(
      existingActivationLicense,
      validDeviceId
    );

    if (!activation || getActivationLicenseShapeError(existingActivationLicense)) {
      return licenseDocumentInvalid();
    }

    return {
      status: 200,
      body: getActivationResponseBody(activation, true),
    };
  }

  const activationId = generateActivationId();
  const activationSalt = generateSalt();
  const activationToken = generateActivationToken({
    licenseKey: licenseToActivate,
    deviceId: validDeviceId,
    activationId,
    salt: activationSalt,
    hmacSecret,
  });
  const activation = {
    activationId,
    deviceId: validDeviceId,
    activationToken,
    ...(validPluginVersion !== undefined
      ? { pluginVersion: validPluginVersion }
      : {}),
    activatedAt: now,
    lastSeenAt: now,
  };

  const newActivationResult = await collection.findOneAndUpdate(
    getNewActivationFilter(licenseToActivate, validDeviceId),
    {
      $push: {
        activations: activation,
      },
    },
    { returnDocument: "after" }
  );
  const newActivationLicense = getFindOneAndUpdateDocument(newActivationResult);

  if (newActivationLicense) {
    return {
      status: 200,
      body: getActivationResponseBody(activation),
    };
  }

  const fallbackLicense = await collection.findOne({
    licenseId: licenseToActivate,
  });

  if (!fallbackLicense) {
    return {
      status: 403,
      body: {
        message: "Invalid license key",
        code: "LICENSE_NOT_FOUND",
      },
    };
  }

  if (getActivationLicenseShapeError(fallbackLicense)) {
    return licenseDocumentInvalid();
  }

  if (getLicenseStatus(fallbackLicense) !== DEFAULT_LICENSE_STATUS) {
    return {
      status: 403,
      body: {
        message: "License is not active",
        code: "LICENSE_NOT_ACTIVE",
      },
    };
  }

  const fallbackActivation = findActivationByDeviceId(
    fallbackLicense,
    validDeviceId
  );

  if (fallbackActivation) {
    return {
      status: 200,
      body: getActivationResponseBody(fallbackActivation, true),
    };
  }

  if (getActivations(fallbackLicense).length >= getMaxActivations(fallbackLicense)) {
    return {
      status: 429,
      body: {
        message: "No more activations",
        code: "ACTIVATION_LIMIT_REACHED",
      },
    };
  }

  return {
    status: 500,
    body: {
      message: "Internal Server Error",
      code: "ACTIVATION_UPDATE_FAILED",
    },
  };
};

const createMongoCollectionProvider = (url) => {
  let clientPromise;
  let collection;

  return async () => {
    if (collection) {
      return collection;
    }

    if (!url) {
      return null;
    }

    if (!clientPromise) {
      const client = new MongoClient(url);
      clientPromise = client.connect().then((connectedClient) => {
        mongoConnected = true;
        return connectedClient;
      });
    }

    const client = await clientPromise;
    const db = client.db(dbName);
    collection = db.collection("licenses");
    return collection;
  };
};

const createApp = ({
  getLicensesCollection = () => licensesCollection,
  getMongoConnected = () => mongoConnected,
  rateLimiter,
  rateLimitOptions,
  hmacSecret = process.env.HMAC_SECRET,
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
  trustProxy = shouldTrustProxy(),
} = {}) => {
  const app = express();

  if (trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use(cors(createCorsOptions(allowedOrigins)));

  // Enable JSON support
  app.use(express.json());

  app.get("/health", (req, res) => {
    const connected = getMongoConnected();
    const statusCode = connected ? 200 : 503;
    res.status(statusCode).json({ status: "ok", mongoConnected: connected });
  });

  const validationRateLimiter =
    rateLimiter || createValidationRateLimiter(rateLimitOptions);

  app.use(["/validate-license", "/activate-license"], validationRateLimiter);

  const handleValidateLicense = async (key, res) => {
    try {
      const result = await validateLicenseKey({
        key,
        collection: await getLicensesCollection(),
        hmacSecret,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("Failed to read or update license in MongoDB:", error);
      res.status(500).json({
        message: "Internal Server Error",
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  };

  app.get("/validate-license", async (req, res) => {
    res.set("Deprecation", "true");
    res.set(
      "Warning",
      '299 - "GET /validate-license is deprecated; use POST /validate-license"'
    );
    await handleValidateLicense(req.query.key, res);
  });

  app.post("/validate-license", async (req, res) => {
    await handleValidateLicense(req.body && req.body.key, res);
  });

  app.post("/activate-license", async (req, res) => {
    try {
      const result = await activateLicense({
        key: req.body && req.body.key,
        deviceId: req.body && req.body.deviceId,
        pluginVersion: req.body && req.body.pluginVersion,
        collection: await getLicensesCollection(),
        hmacSecret,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("Failed to activate license using MongoDB:", error);
      res.status(500).json({
        message: "Internal Server Error",
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  });

  return app;
};

const startServer = async () => {
  const url = process.env.MONGODB_URI;
  const hmacSecret = process.env.HMAC_SECRET;

  if (!url) {
    console.error("Missing required environment variable MONGODB_URI.");
    process.exit(1);
  }

  if (!hmacSecret) {
    console.error("Missing required environment variable HMAC_SECRET.");
    process.exit(1);
  }

  const client = new MongoClient(url);

  try {
    for (let attempt = 1; attempt <= maxConnectAttempts; attempt += 1) {
      try {
        await client.connect();
        mongoConnected = true;
        const db = client.db(dbName);
        licensesCollection = db.collection("licenses");
        break;
      } catch (error) {
        console.error(
          `MongoDB connection attempt ${attempt} failed:`,
          error
        );
        if (attempt === maxConnectAttempts) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, connectRetryDelayMs)
        );
      }
    }

    const app = createApp({ hmacSecret });
    app.listen(port, () => {
      console.log(`Listening on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

const serverlessApp = createApp({
  getLicensesCollection: createMongoCollectionProvider(process.env.MONGODB_URI),
  hmacSecret: process.env.HMAC_SECRET,
});

module.exports = serverlessApp;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
module.exports.setLicensesCollection = (collection) => {
  licensesCollection = collection;
};
module.exports.setMongoConnected = (connected) => {
  mongoConnected = connected;
};
