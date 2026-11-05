import { handle } from "hono/aws-lambda";
import app from "./app.js";

// AWS Lambda entry point (mirrors the monolith's handler.ts convention).
export const handler = handle(app);
