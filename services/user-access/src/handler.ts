import { handle } from "hono/aws-lambda";
import app from "./app.js";

// AWS Lambda entry point (mirrors the other services' handler.ts convention).
export const handler = handle(app);
