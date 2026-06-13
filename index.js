const express = require("express");
const cors = require("cors");
const cryptoJs = require("crypto-js");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");

const port = process.env.PORT || 3000;

const dbName = "licenseDatabase";
let licensesCollection;
let mongoConnected = false;
const maxConnectAttempts = 5;
const connectRetryDelayMs = 1000;
const DEFAULT_VALIDATION_LIMIT = 3;

const defaultRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
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

const createApp = ({
  getLicensesCollection = () => licensesCollection,
  getMongoConnected = () => mongoConnected,
  rateLimiter = defaultRateLimiter,
} = {}) => {
  const app = express();

  app.use(cors());

  // Enable JSON support
  app.use(express.json());

  app.get("/health", (req, res) => {
    const connected = getMongoConnected();
    const statusCode = connected ? 200 : 503;
    res.status(statusCode).json({ status: "ok", mongoConnected: connected });
  });

  app.use("/validate-license", rateLimiter);

  app.get("/validate-license", async (req, res) => {
    const { value: licenseToValidate, error: keyError } = getValidLicenseKey(
      req.query.key
    );

    if (keyError) {
      res.status(400).json(keyError);
      return;
    }

    try {
      const collection = getLicensesCollection();
      if (!collection) {
        res.status(503).json({
          message: "Database not ready",
          code: "DATABASE_NOT_READY",
        });
        return;
      }

      const salt = cryptoJs.lib.WordArray.random(128 / 8).toString();
      const validationString = cryptoJs
        .HmacSHA256(licenseToValidate, salt)
        .toString();

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
          res.status(403).json({
            message: "Invalid license key",
            code: "LICENSE_NOT_FOUND",
          });
          return;
        }

        if (existingLicense.validationNumber >= DEFAULT_VALIDATION_LIMIT) {
          res.status(429).json({
            message: "Validation limit reached",
            code: "VALIDATION_LIMIT_REACHED",
          });
          return;
        }

        res.status(500).json({
          message: "Internal Server Error",
          code: "LICENSE_UPDATE_FAILED",
        });
        return;
      }

      // Return validationString value in the response body only after update.
      res.status(200).json({
        message: "OK",
        validationString: validationString,
      });
    } catch (error) {
      console.error("Failed to read or update license in MongoDB:", error);
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

  if (!url) {
    console.error("Missing required environment variable MONGODB_URI.");
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

    const app = createApp();
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

module.exports = {
  createApp,
  startServer,
  setLicensesCollection: (collection) => {
    licensesCollection = collection;
  },
  setMongoConnected: (connected) => {
    mongoConnected = connected;
  },
};
