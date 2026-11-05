import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Shared DynamoDB document client factory. Each service constructs its own client
 * and knows ONLY its own table names — a service must never reference another
 * context's table (Single Responsibility / bounded-context data ownership).
 *
 * The full table catalog lives in the monolith (apps/backend/src/lib/dynamo.ts);
 * each extracted service declares only the subset it owns, in its own module.
 */
export function createDocClient() {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export type DocClient = ReturnType<typeof createDocClient>;
