const express = require("express");
const cors = require("cors");
const cryptoJs = require("crypto-js");
const { MongoClient } = require("mongodb");
const rateLimit = require("express-rate-limit");

const port = process.env.PORT || 3000;

// Connection URL and Database Settings
const url = process.env.MONGODB_URI;
const dbName = "licenseDatabase";
const client = new MongoClient(url);
let licensesCollection;
let mongoConnected = false;
const maxConnectAttempts = 5;
const connectRetryDelayMs = 1000;

if (!url) {
  console.error("Missing required environment variable MONGODB_URI.");
  process.exit(1);
}

const defaultRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

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
    const licenseToValidate = req.query.key;

    try {
      const collection = getLicensesCollection();
      if (!collection) {
        res.status(503).json({
          message: "Database not ready",
          code: "DATABASE_NOT_READY",
        });
        return;
      }

      const licenseObj = await collection.findOne({
        licenseId: licenseToValidate,
      });

      if (!licenseObj) {
        res.status(403).json({
          message: "Invalid license key",
          code: "LICENSE_NOT_FOUND",
        });
        return;
      }

      if (licenseObj.validationNumber >= 3) {
        res.status(429).json({
          message: "Validation limit reached",
          code: "VALIDATION_LIMIT_REACHED",
        });
        return;
      }

      const salt = cryptoJs.lib.WordArray.random(128 / 8).toString();
      const validationString = cryptoJs
        .HmacSHA256(licenseToValidate, salt)
        .toString();
      licenseObj.validationNumber += 1;
      licenseObj.validationStrings.push(validationString);
      licenseObj.saltStrings.push(salt);
      // Update the license document in MongoDB
      await collection.updateOne(
        { licenseId: licenseToValidate },
        {
          $set: {
            validationNumber: licenseObj.validationNumber,
            validationStrings: licenseObj.validationStrings,
            saltStrings: licenseObj.saltStrings,
          },
        }
      );

      // Return validationString value in the response body
      res.status(200).json({
        message: "OK",
        validationString: validationString,
      });
    } catch (error) {
      console.error("Failed to read, update, or parse licenses file:", error);
      res.status(500).json({
        message: "Internal Server Error",
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  });

  return app;
};

const startServer = async () => {
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
