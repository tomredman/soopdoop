// ABOUTME: The Convex app definition. Declares the deployment's environment variables, so functions read them typed (env).
// ABOUTME: ANTHROPIC_API_KEY pays for the Operator (the crew leader's key); OPERATOR_FAKE=1 answers without Claude, for tests.
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    ANTHROPIC_API_KEY: v.optional(v.string()),
    OPERATOR_FAKE: v.optional(v.string()),
  },
});

export default app;
