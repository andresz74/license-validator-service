const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const path = require("path");
const cryptoJs = require('crypto-js');
const { MongoClient } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// Enable JSON support
app.use(express.json());

// Connection URL and Database Settings
const url = process.env.MONGODB_URI;
const dbName = "licenseDatabase";
const client = new MongoClient(url);
let licensesCollection;
let mongoConnected = false;

if (!url) {
  console.error("Missing required environment variable MONGODB_URI.");
  process.exit(1);
}

app.get("/health", (req, res) => {
  const statusCode = mongoConnected ? 200 : 503;
  res.status(statusCode).json({ status: "ok", mongoConnected });
});

app.get("/validate-license", async (req, res) => {
  const licenseToValidate = req.query.key;

  try {
    if (!licensesCollection) {
      res.status(503).json({ message: "Database not ready" });
      return;
    }

    const licenseObj = await licensesCollection.findOne({
      licenseId: licenseToValidate,
    });

    if (licenseObj) {
      if (licenseObj.validationNumber < 3) {
        const salt = cryptoJs.lib.WordArray.random(128/8).toString();
        const validationString = cryptoJs.HmacSHA256(licenseToValidate, salt).toString();
        licenseObj.validationNumber += 1;
        licenseObj.validationStrings.push(validationString);
        licenseObj.saltStrings.push(salt);
        // Update the license document in MongoDB
        await licensesCollection.updateOne(
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
        res
          .status(200)
          .json({ message: "OK", validationString: validationString });
      } else {
        res.status(429).json({ message: "No more validations" });
      }
    } else {
      res.status(403).json({ message: "KO" });
    }
  } catch (error) {
    console.error("Failed to read, update, or parse licenses file:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

const startServer = async () => {
  try {
    await client.connect();
    mongoConnected = true;
    const db = client.db(dbName);
    licensesCollection = db.collection("licenses");
    app.listen(port, () => {
      console.log(`Listening on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    process.exit(1);
  }
};

startServer();
