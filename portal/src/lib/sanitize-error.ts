const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Patterns that indicate the message contains sensitive infrastructure details.
 * Each pattern is paired with a short label for logging (not sent to the client).
 */
const SENSITIVE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // AWS Account IDs (12-digit numbers that appear in ARN-like contexts)
  [/\b\d{12}\b/, "aws-account-id"],
  // AWS ARNs
  [/arn:[a-z0-9-]*:[a-z0-9-]*:[a-z0-9-]*:\d{0,12}:/, "aws-arn"],
  // IAM role/user/policy references
  [/\b(role|user|policy)\/[A-Za-z0-9_+=,.@-]+/, "iam-entity"],
  // Internal hostnames (*.internal, *.local, *.amazonaws.com, ip-based)
  [/\b[a-z0-9-]+\.(internal|local|amazonaws\.com|compute\.internal)\b/, "internal-hostname"],
  // IP addresses (private ranges and any IP in error text is suspicious)
  [/\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/, "private-ip"],
  // Absolute filesystem paths (Linux and Windows)
  [/\/(usr|var|opt|etc|home|tmp|root|srv)\/[^\s'"]+/, "filesystem-path"],
  [/[A-Z]:\\[^\s'"]+/, "windows-path"],
  // Webpack internal paths
  [/webpack-internal:\/\//, "webpack-path"],
  // DynamoDB / S3 / other AWS resource names in error context
  [/\b(table|bucket|function|queue|topic)\s*[:=]\s*['"]?[A-Za-z0-9_-]{3,}/, "aws-resource"],
  // Lambda function names (typical naming patterns)
  [/\bfunction:\s*[A-Za-z0-9_-]+-[A-Za-z0-9_-]+-(dev|prod|staging|main)\b/, "lambda-function"],
  // Stack traces that leaked through
  [/\bat\s+\S+\s+\([^)]*:\d+:\d+\)/, "stack-trace"],
  // Node module paths
  [/node_modules\/[^\s'"]+/, "node-modules-path"],
  // Access key IDs
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/, "aws-access-key"],
];

/** Generic safe messages keyed by HTTP status family. */
const GENERIC_MESSAGES: Record<number, string> = {
  400: "The request was invalid.",
  401: "Authentication required.",
  403: "You do not have permission to perform this action.",
  404: "The requested resource was not found.",
  409: "A conflict occurred. Please try again.",
  429: "Too many requests. Please wait and try again.",
  500: "An internal error occurred. Please try again later.",
  502: "A service is temporarily unavailable. Please try again later.",
  503: "A service is temporarily unavailable. Please try again later.",
  504: "The request timed out. Please try again later.",
};

function genericMessageForStatus(status?: number): string {
  if (status && GENERIC_MESSAGES[status]) {
    return GENERIC_MESSAGES[status];
  }
  if (status && status >= 500) {
    return GENERIC_MESSAGES[500];
  }
  if (status && status >= 400) {
    return "The request could not be completed.";
  }
  return "An unexpected error occurred. Please try again later.";
}

/**
 * Returns true if the message contains patterns indicative of sensitive
 * infrastructure information that should not be shown to end users.
 */
export function containsSensitiveContent(message: string): boolean {
  return SENSITIVE_PATTERNS.some(([pattern]) => pattern.test(message));
}

/**
 * The longest an upstream message may be and still be plausibly hand-written for a reader.
 * Beyond this it is a raw error page, a stack dump or a serialised object, none of which a
 * service wrote for a person, whatever code it arrived with.
 */
const MAX_PASSTHROUGH_CHARS = 300;

/**
 * Sanitize an UPSTREAM error message for client consumption.
 *
 * ⚠ DEFAULT-DENY: without a `code`, the message is replaced. See the header for why the
 * inverse (pass unless a regex objects) is not good enough.
 *
 * @param message - The raw error message from upstream
 * @param status  - The HTTP status code, used to select an appropriate generic message
 * @param code    - The service's machine-readable code, if it attached one. Its PRESENCE is
 *                  the signal that the message was authored for a reader; its value is not
 *                  inspected, so a new coded refusal needs no change here.
 * @returns A safe message for the client
 */
export function sanitizeErrorMessage(
  message: string,
  status?: number,
  code?: string | null
): string {
  if (!IS_PRODUCTION) {
    return message;
  }

  if (!message) return genericMessageForStatus(status);

  // No code ⇒ nobody wrote this for a reader ⇒ it does not reach one.
  if (!code) return genericMessageForStatus(status);

  // Coded, but still checked: a service can interpolate an SDK error into its own message.
  if (containsSensitiveContent(message)) return genericMessageForStatus(status);

  // Coded and clean, but far too long to be a sentence written for a person.
  if (message.length > MAX_PASSTHROUGH_CHARS) return genericMessageForStatus(status);

  return message;
}

/**
 * The generic message for a status, exported so callers that must not pass ANY upstream text
 * (or that have no message at all) can produce the same wording as the sanitiser.
 */
export function genericMessage(status?: number): string {
  return genericMessageForStatus(status);
}
