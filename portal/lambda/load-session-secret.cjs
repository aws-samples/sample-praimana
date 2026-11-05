"use strict";

/**
 * Lambda cold-start entrypoint for the portal: reads the session-signing key from AWS Secrets Manager,
 * places it in `process.env`, then starts the Next standalone server.
 *
 * The key is never a Lambda environment variable, so `lambda:GetFunctionConfiguration` cannot read it.
 * The function holds only the secret's ARN (`NEXTAUTH_SECRET_ARN`); the value is fetched here, once per
 * execution environment, before `server.js` is required. `src/lib/session-cookie.ts` reads the key at
 * module load, which happens after this file has set it.
 *
 * Secret value (JSON):
 *   { "NEXTAUTH_SECRET": "<current key>", "NEXTAUTH_SECRET_PREVIOUS": "<outgoing key, rotation only>" }
 *
 * Any failure exits non-zero, so the execution environment fails to initialise and the error is in the
 * function's log group. There is no fallback key.
 *
 * The AWS SDK client is the one bundled with the Lambda Node.js runtime (resolved through NODE_PATH), so
 * the portal's own dependencies are unchanged. CommonJS on purpose: NODE_PATH is not consulted by ESM.
 */

const path = require("node:path");

const SECRET_ARN_ENV = "NEXTAUTH_SECRET_ARN";
const CURRENT_KEY = "NEXTAUTH_SECRET";
const PREVIOUS_KEY = "NEXTAUTH_SECRET_PREVIOUS";
const MIN_SECRET_LENGTH = 32;
const FETCH_TIMEOUT_MS = 5000;
const SDK_MAX_ATTEMPTS = 3;
const SECRET_ARN_PATTERN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
const SERVER_ENTRY = path.join(__dirname, "server.js");

class SessionSecretError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionSecretError";
  }
}

/** Validates the ARN taken from the environment before it is used as a SecretId. */
function readSecretArn(env) {
  const arn = env[SECRET_ARN_ENV];
  if (typeof arn !== "string" || arn.length === 0) {
    throw new SessionSecretError(`${SECRET_ARN_ENV} is not set`);
  }
  if (!SECRET_ARN_PATTERN.test(arn)) {
    throw new SessionSecretError(`${SECRET_ARN_ENV} is not a Secrets Manager secret ARN`);
  }
  return arn;
}

function assertKey(value, name) {
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
    throw new SessionSecretError(`${name} must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }
}

/**
 * Parses and validates the secret value. Error messages never include the value: `JSON.parse` errors
 * quote the input in recent Node versions, so they are replaced rather than passed through.
 */
function parseSessionSecret(secretString) {
  if (typeof secretString !== "string") {
    throw new SessionSecretError("secret has no SecretString");
  }
  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new SessionSecretError("secret value is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SessionSecretError("secret value must be a JSON object");
  }
  assertKey(parsed[CURRENT_KEY], CURRENT_KEY);
  const previous = parsed[PREVIOUS_KEY];
  const hasPrevious = previous !== undefined && previous !== null && previous !== "";
  if (hasPrevious) assertKey(previous, PREVIOUS_KEY);
  return { current: parsed[CURRENT_KEY], previous: hasPrevious ? previous : undefined };
}

/** Fetches the secret and writes the keys into `env`. `getSecretString` is injected for tests. */
async function loadSessionSecret({ env, getSecretString }) {
  const arn = readSecretArn(env);
  const { current, previous } = parseSessionSecret(await getSecretString(arn));
  env[CURRENT_KEY] = current;
  if (previous === undefined) {
    delete env[PREVIOUS_KEY];
  } else {
    env[PREVIOUS_KEY] = previous;
  }
  return { hasPrevious: previous !== undefined };
}

/** Production fetch: the runtime-bundled SDK, bounded retries and an explicit timeout. */
async function getSecretStringFromSecretsManager(arn) {
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ maxAttempts: SDK_MAX_ATTEMPTS });
  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }), {
    abortSignal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return response.SecretString;
}

function log(level, event, fields) {
  const line = JSON.stringify({ level, event, component: "portal-bootstrap", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main() {
  try {
    const { hasPrevious } = await loadSessionSecret({
      env: process.env,
      getSecretString: getSecretStringFromSecretsManager,
    });
    log("info", "session_secret_loaded", { rotationOverlap: hasPrevious });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof SessionSecretError ? error.message : "failed to read the session secret";
    log("error", "session_secret_load_failed", { errorName: name, message });
    process.exit(1);
  }
  require(SERVER_ENTRY);
}

module.exports = {
  SECRET_ARN_ENV,
  MIN_SECRET_LENGTH,
  SessionSecretError,
  readSecretArn,
  parseSessionSecret,
  loadSessionSecret,
};

if (require.main === module) {
  void main();
}
