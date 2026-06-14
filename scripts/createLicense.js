const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const DEFAULT_DATABASE_NAME = "licenseDatabase";
const DEFAULT_COLLECTION_NAME = "licenses";
const DEFAULT_PREFIX = "PSP";
const DEFAULT_MAX_ACTIVATIONS = 3;
const DEFAULT_SOURCE = "script";
const MAX_DUPLICATE_ATTEMPTS = 5;
const LICENSE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const parseDotEnvLine = (line) => {
  const trimmedLine = line.trim();

  if (!trimmedLine || trimmedLine.startsWith("#")) {
    return null;
  }

  const equalsIndex = trimmedLine.indexOf("=");

  if (equalsIndex === -1) {
    return null;
  }

  const key = trimmedLine.slice(0, equalsIndex).trim();
  let value = trimmedLine.slice(equalsIndex + 1).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
};

const loadDotEnv = ({
  env = process.env,
  filePath = path.join(process.cwd(), ".env"),
} = {}) => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");

  contents.split(/\r?\n/).forEach((line) => {
    const parsedLine = parseDotEnvLine(line);

    if (!parsedLine || env[parsedLine.key] !== undefined) {
      return;
    }

    env[parsedLine.key] = parsedLine.value;
  });
};

const parsePositiveInteger = (value, optionName) => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
};

const requireOptionValue = (args, index, optionName) => {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
};

const parseCreateLicenseArgs = (args = process.argv.slice(2)) => {
  const options = {
    maxActivations: DEFAULT_MAX_ACTIVATIONS,
    source: DEFAULT_SOURCE,
    prefix: DEFAULT_PREFIX,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--max-activations") {
      const value = requireOptionValue(args, index, arg);
      options.maxActivations = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }

    if (arg === "--source") {
      options.source = requireOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--prefix") {
      options.prefix = requireOptionValue(args, index, arg).toUpperCase();
      index += 1;
      continue;
    }

    throw new Error(`Unknown option ${arg}.`);
  }

  if (!/^[A-Z]{2,10}$/.test(options.prefix)) {
    throw new Error("--prefix must contain 2 to 10 letters.");
  }

  return options;
};

const randomLicenseCharacter = () =>
  LICENSE_CHARACTERS[
    crypto.randomInt(0, LICENSE_CHARACTERS.length)
  ];

const generateLicenseKey = ({
  prefix = DEFAULT_PREFIX,
  groups = 3,
  groupLength = 4,
} = {}) => {
  const keyGroups = [];

  for (let groupIndex = 0; groupIndex < groups; groupIndex += 1) {
    let group = "";

    for (let charIndex = 0; charIndex < groupLength; charIndex += 1) {
      group += randomLicenseCharacter();
    }

    keyGroups.push(group);
  }

  return `${prefix}-${keyGroups.join("-")}`;
};

const buildLicenseDocument = ({
  licenseId,
  maxActivations = DEFAULT_MAX_ACTIVATIONS,
  source = DEFAULT_SOURCE,
  now = new Date(),
}) => {
  const timestamp = now.toISOString();

  return {
    licenseId,
    status: "active",
    maxActivations,
    activations: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    source,
  };
};

const isDuplicateKeyError = (error) => error && error.code === 11000;

const insertLicenseWithRetry = async ({
  collection,
  prefix,
  maxActivations,
  source,
  attempts = MAX_DUPLICATE_ATTEMPTS,
}) => {
  let lastDuplicateError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const licenseId = generateLicenseKey({ prefix });
    const license = buildLicenseDocument({
      licenseId,
      maxActivations,
      source,
    });

    try {
      await collection.insertOne(license);
      return license;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      lastDuplicateError = error;
    }
  }

  throw new Error(
    `Failed to generate a unique license key after ${attempts} attempts.${
      lastDuplicateError ? ` Last duplicate error: ${lastDuplicateError.message}` : ""
    }`
  );
};

const printLicenseSummary = (license) => {
  console.log("License created");
  console.log("");
  console.log(`License ID: ${license.licenseId}`);
  console.log(`Status: ${license.status}`);
  console.log(`Max activations: ${license.maxActivations}`);
  console.log(`Source: ${license.source}`);
};

const run = async ({
  args = process.argv.slice(2),
  env = process.env,
  dotEnvFilePath,
  MongoClientClass = MongoClient,
} = {}) => {
  loadDotEnv({
    env,
    ...(dotEnvFilePath ? { filePath: dotEnvFilePath } : {}),
  });

  if (!env.MONGODB_URI) {
    console.error("Missing required environment variable MONGODB_URI.");
    process.exitCode = 1;
    return;
  }

  let options;

  try {
    options = parseCreateLicenseArgs(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const client = new MongoClientClass(env.MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(env.MONGODB_DATABASE || DEFAULT_DATABASE_NAME);
    const collection = db.collection(
      env.LICENSE_COLLECTION || DEFAULT_COLLECTION_NAME
    );
    const license = await insertLicenseWithRetry({
      collection,
      prefix: options.prefix,
      maxActivations: options.maxActivations,
      source: options.source,
    });

    printLicenseSummary(license);
  } catch (error) {
    console.error(`Failed to create license: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
};

if (require.main === module) {
  run();
}

module.exports = {
  buildLicenseDocument,
  generateLicenseKey,
  insertLicenseWithRetry,
  loadDotEnv,
  parseDotEnvLine,
  parseCreateLicenseArgs,
  run,
};
