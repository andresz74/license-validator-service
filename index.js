const fs = require("fs/promises");
const express = require("express");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
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
// Connect to MongoDB
client.connect();

const db = client.db(dbName);
const licensesCollection = db.collection("licenses");

app.get("/validate-license", async (req, res) => {
  const licenseToValidate = req.query.key;
  const licensesPath = path.join(__dirname, "licenses.json");

  try {
    const licenseObj = await licensesCollection.findOne({
      licenseId: licenseToValidate,
    });

    if (licenseObj) {
      if (licenseObj.validationNumber < 3) {
        const validationString = uuidv4();
        licenseObj.validationNumber += 1;
        licenseObj.validationStrings.push(validationString);
        // Update the license document in MongoDB
        await licensesCollection.updateOne(
          { licenseId: licenseToValidate },
          {
            $set: {
              validationNumber: licenseObj.validationNumber,
              validationStrings: licenseObj.validationStrings,
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

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
