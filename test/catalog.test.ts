import assert from "node:assert/strict";
import test from "node:test";
import { fetchModelCatalog, normalizeBaseUrl, parseModelCatalog } from "../src/catalog.ts";

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "gpt-5.3-codex",
    name: "GPT-5.3-Codex",
    model_picker_enabled: true,
    capabilities: {
      type: "chat",
      limits: {
        max_context_window_tokens: 400000,
        max_output_tokens: 128000,
        max_prompt_tokens: 272000,
      },
      supports: {
        reasoning_effort: ["low", "medium", "high", "xhigh"],
        tool_calls: true,
        vision: true,
      },
    },
    supported_endpoints: ["/responses", "ws:/responses"],
    ...overrides,
  };
}

test("maps Copilot model capabilities and response API metadata", () => {
  const [parsed] = parseModelCatalog({ data: [model()] });

  assert.equal(parsed.id, "gpt-5.3-codex");
  assert.equal(parsed.name, "GPT-5.3-Codex");
  assert.equal(parsed.api, "openai-responses");
  assert.equal(parsed.contextWindow, 400000);
  assert.equal(parsed.maxTokens, 128000);
  assert.deepEqual(parsed.input, ["text", "image"]);
  assert.equal(parsed.reasoning, true);
  assert.equal(parsed.thinkingLevelMap?.xhigh, "xhigh");
  assert.equal(parsed.thinkingLevelMap?.max, null);
});

test("chooses a supported endpoint and excludes unavailable/non-chat models", () => {
  const models = parseModelCatalog({
    data: [
      model({ id: "chat-only", supported_endpoints: ["/chat/completions"] }),
      model({ id: "claude", supported_endpoints: ["/messages"] }),
      model({ id: "hidden", model_picker_enabled: false }),
      model({
        id: "embedding",
        capabilities: { type: "embeddings", limits: {} },
      }),
      model({ id: "unsupported", supported_endpoints: ["/embeddings"] }),
    ],
  });

  assert.deepEqual(models.map(({ id, api }) => [id, api]), [
    ["chat-only", "openai-completions"],
    ["claude", "anthropic-messages"],
  ]);
});

test("rejects malformed discovery responses and unusable chat model limits", () => {
  assert.throws(() => parseModelCatalog({ models: [] }), /data array/);
  assert.throws(
    () => parseModelCatalog({ data: [model({ capabilities: { type: "chat", limits: {} } })] }),
    /max_context_window_tokens/,
  );
});

test("normalizes HTTPS URLs and permits plain HTTP only for loopback", () => {
  assert.equal(normalizeBaseUrl("https://copilot.example/api/"), "https://copilot.example/api");
  assert.equal(normalizeBaseUrl("http://localhost:8080/"), "http://localhost:8080");
  assert.throws(() => normalizeBaseUrl("http://copilot.example"), /must use HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@copilot.example"), /must not contain credentials/);
});

test("fetches models from /models with bearer auth and the caller abort signal", async () => {
  const controller = new AbortController();
  let requestedUrl = "";
  let authorization = "";
  let receivedSignal: AbortSignal | undefined;

  const models = await fetchModelCatalog(
    "https://copilot.example/api/",
    "secret-token",
    controller.signal,
    async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      receivedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ data: [model()] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.equal(requestedUrl, "https://copilot.example/api/models");
  assert.equal(authorization, "Bearer secret-token");
  assert.equal(receivedSignal, controller.signal);
  assert.equal(models.length, 1);
});

test("reports HTTP errors without including response bodies", async () => {
  await assert.rejects(
    () =>
      fetchModelCatalog(
        "https://copilot.example",
        "secret-token",
        new AbortController().signal,
        async () => new Response("sensitive provider details", { status: 403 }),
      ),
    (error: Error) => error.message === "Power-Copilot model discovery failed with HTTP 403",
  );
});
