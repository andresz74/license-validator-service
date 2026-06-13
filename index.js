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
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 100;

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

const getFindOneAndUpdateDocument = (result) => {
  if (!result) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(result, "value")) {
    return result.value;
  }

  return result;
};

const generateSalt = () => crypto.randomBytes(16).toString("hex");

const generateValidationString = (licenseKey, salt, hmacSecret) =>
  crypto
    .createHmac("sha256", hmacSecret)
    .update(`${licenseKey}:${salt}`)
    .digest("hex");

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

  const salt = generateSalt();
  const validationString = generateValidationString(
    licenseToValidate,
    salt,
    hmacSecret
  );

  const updateResult = await collection.findOneAndUpdate(
    {
      licenseId: licenseToValidate,
      validationNumber: { $lt: DEFAULT_VALIDATION_LIMIT },
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

    if (existingLicense.validationNumber >= DEFAULT_VALIDATION_LIMIT) {
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
  trustProxy = getBoolean(process.env.TRUST_PROXY),
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

  app.use(
    "/validate-license",
    rateLimiter || createValidationRateLimiter(rateLimitOptions)
  );

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
