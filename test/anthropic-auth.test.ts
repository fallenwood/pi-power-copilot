import assert from "node:assert/strict";
import test from "node:test";
import { withCopilotBearerAuth } from "../src/anthropic-auth.ts";

test("passes the current Copilot credential as Bearer auth instead of an Anthropic API key", () => {
  const original = {
    apiKey: "copilot-token",
    headers: {
      "X-Custom": "value",
      Authorization: "Bearer stale-token",
      authorization: "Bearer older-token",
    },
    maxTokens: 1234,
  };

  const options = withCopilotBearerAuth(original);

  assert.deepEqual(options, {
    apiKey: undefined,
    headers: {
      "X-Custom": "value",
      authorization: "Bearer copilot-token",
    },
    maxTokens: 1234,
  });
  assert.equal(original.apiKey, "copilot-token");
  assert.equal(original.headers.Authorization, "Bearer stale-token");
  assert.equal(original.headers.authorization, "Bearer older-token");
  assert.equal(
    withCopilotBearerAuth({ apiKey: "refreshed-token" })?.headers?.authorization,
    "Bearer refreshed-token",
  );
});

test("leaves requests without an API key to the adapter's existing auth validation", () => {
  assert.equal(withCopilotBearerAuth(undefined), undefined);
  const options = { headers: { authorization: "Bearer caller-token" }, reasoning: "high" as const };
  assert.equal(withCopilotBearerAuth(options), options);
});
