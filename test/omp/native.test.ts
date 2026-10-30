import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { createOmpPowerCopilotProvider } from "../../src/omp-provider.ts";
import { COPILOT_REQUEST_HEADERS } from "../../src/copilot-headers.ts";

// Native OMP packages require Bun. Isolate directories and credentials before loading them.
const root = mkdtempSync(join(tmpdir(), "power-copilot-omp-native-"));
const originalEnv = { ...process.env };
for (const name of Object.keys(process.env)) {
  if (/TOKEN|API_KEY|SECRET|PASSWORD|^PI_|^OMP_|^XDG_/i.test(name)) delete process.env[name];
}
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = root;
const originalFetch = globalThis.fetch;
const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
const { streamSimple } = await import("@oh-my-pi/pi-ai");
const { ModelRegistry } = await import("@oh-my-pi/pi-coding-agent/config/model-registry");
const { default: extension } = await import("../../src/omp.ts");

beforeEach(() => {
  globalThis.fetch = (async () => { throw new Error("Unexpected real network request"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  rmSync(root, { recursive: true, force: true });
});

function catalog() {
  return { data: [
    ["responses", "/responses"], ["messages", "/messages"], ["chat", "/chat/completions"],
  ].map(([id, endpoint]) => ({ id: `fixture-${id}`, name: id, supported_endpoints: [endpoint], capabilities: {
    type: "chat", limits: { max_context_window_tokens: 10000, max_output_tokens: 2000 },
  } })) };
}

function sse(events: Record<string, unknown>[], done = false) {
  const data = events.map((event) => `event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : "");
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

function responseStream() {
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Hello 世界", annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello 世界" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
  ]);
}
function messageStream() {
  return sse([
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant",
      model: "fixture-messages", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello 世界" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}
function chatStream() {
  return sse([
    { id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: "fixture-chat",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hello 世界" }, finish_reason: null }] },
    { id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: "fixture-chat",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ], true);
}

async function runtime(dir: string) {
  const auth = await AuthStorage.create(join(dir, "auth.db"));
  await auth.credentials.reload();
  const registry = new ModelRegistry(auth, join(dir, "models.yml"), { cacheDbPath: join(dir, "models.db") });
  return { auth, registry };
}

function registerExtension(registry: InstanceType<typeof ModelRegistry>, source: string) {
  let refresh: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  extension({
    registerProvider: (name, config) => registry.registerProvider(name, config, source),
    registerCommand: (name, command) => {
      assert.equal(name, "power-copilot-refresh");
      refresh = command;
    },
  } as ExtensionAPI);
  assert.ok(refresh);
  const { handler } = refresh;
  return () => handler("", { modelRegistry: registry, ui: { notify() {} } } as unknown as ExtensionCommandContext);
}

test("OMP manifest loads its native entry, discovers models, and streams all three native protocols", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.omp.extensions, ["./src/omp.ts"]);
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.equal(pkg.exports["./omp"], "./src/omp.ts");
  const { auth, registry } = await runtime(root);
  try {
    await auth.credentials.set("github-copilot", { type: "api_key", key: "must-not-be-used" });
    await auth.credentials.set("power-copilot", { type: "api_key", key: "fixture-key", source: "login" });
    registerExtension(registry, "fixture-extension");
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer fixture-key");
      assert.equal(headers.has("x-api-key"), false);
      for (const [name, value] of Object.entries(COPILOT_REQUEST_HEADERS)) assert.equal(headers.get(name), value);
      if (url.endsWith("/models")) return Response.json(catalog());
      if (url.endsWith("/responses")) return responseStream();
      if (url.includes("/v1/messages")) return messageStream();
      assert.ok(url.endsWith("/chat/completions"), `Unexpected endpoint: ${url}`);
      return chatStream();
    }) as typeof fetch;
    await registry.refreshRuntimeProviders("online");
    const models = registry.getAll().filter((model) => model.provider === "power-copilot");
    assert.equal(models.length, 3);
    let payloads = 0;
    for (const model of models) {
      const apiKey = await registry.getApiKey(model);
      const headers = await model.resolveHeaders?.();
      const result = await streamSimple(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, {
        apiKey, headers, maxTokens: 100, maxRetryDelayMs: 0,
        maxInFlightRequests: { "power-copilot": 1 }, signal: AbortSignal.timeout(2000),
        onPayload: () => { payloads++; },
      }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(result.provider, "power-copilot");
      assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join(""), "Hello 世界");
      assert.equal(result.usage.input, 10);
      assert.equal(result.usage.output, 3);
    }
    assert.equal(requests.length, 4);
    assert.equal(payloads, 3, "request inspection runs once per protocol request");
    registry.clearSourceRegistrations("fixture-extension");
  } finally { auth.close(); }
});

test("OMP owns OAuth renewal and discovery retains enterprise metadata across a native restart", async () => {
  const dir = join(root, "oauth");
  const { auth, registry } = await runtime(dir);
  try {
    let exchanges = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/copilot_internal/v2/token")) {
        exchanges++;
        return Response.json({ token: "fresh-copilot", expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      assert.equal(url, "https://api.enterprise.githubcopilot.com/models");
      return Response.json(catalog());
    }) as typeof fetch;
    const refresh = registerExtension(registry, "oauth-fixture");
    // Raw legacy credentials are accepted on refresh, then persisted in OMP's routing envelope.
    await auth.credentials.set("power-copilot", { type: "oauth", refresh: "fixture-github", access: "old-copilot",
      expires: 1, enterpriseUrl: "company.ghe.com" });
    await refresh();
    assert.equal(await auth.keys.get("power-copilot"), "fresh-copilot");
    assert.equal(exchanges, 1);
    assert.match(auth.credentials.getOAuth("power-copilot")!.access, /^power-copilot-oauth-v1:/);
    assert.equal(registry.find("power-copilot", "fixture-messages")?.baseUrl, "https://api.enterprise.githubcopilot.com");
    registry.clearSourceRegistrations("oauth-fixture");
  } finally { auth.close(); }
  const restarted = await runtime(dir);
  try {
    restarted.registry.registerProvider("power-copilot", createOmpPowerCopilotProvider(join(dir, "power-copilot.json")), "restart-fixture");
    assert.equal(await restarted.auth.keys.get("power-copilot"), "fresh-copilot");
    await restarted.registry.refreshRuntimeProviders("online");
    assert.equal(restarted.registry.find("power-copilot", "fixture-responses")?.baseUrl, "https://api.enterprise.githubcopilot.com");
    restarted.registry.clearSourceRegistrations("restart-fixture");
  } finally { restarted.auth.close(); }
});

test("OMP caches effective windows; explicit rediscovery makes edits and removals reversible", async () => {
  const dir = join(root, "cache");
  const first = await runtime(dir);
  const path = join(dir, "power-copilot.json");
  writeFileSync(path, '{"contextWindows":{"fixture-responses":1234}}');
  try {
    await first.auth.credentials.set("power-copilot", { type: "api_key", key: "fixture-key", source: "login" });
    first.registry.registerProvider("power-copilot", createOmpPowerCopilotProvider(path), "cache-fixture");
    globalThis.fetch = (async () => Response.json(catalog())) as typeof fetch;
    await first.registry.refreshRuntimeProviders("online");
    assert.equal(first.registry.find("power-copilot", "fixture-responses")?.contextWindow, 1234);
    first.registry.clearSourceRegistrations("cache-fixture");
  } finally { first.auth.close(); }
  const next = await runtime(dir);
  try {
    writeFileSync(path, '{}');
    next.registry.registerProvider("power-copilot", createOmpPowerCopilotProvider(path), "cache-restart-fixture");
    globalThis.fetch = (async () => { throw new Error("Offline cache must not request the network"); }) as typeof fetch;
    await next.registry.refreshRuntimeProviders("offline");
    assert.equal(next.registry.find("power-copilot", "fixture-responses")?.contextWindow, 1234);
    globalThis.fetch = (async () => Response.json(catalog())) as typeof fetch;
    await next.registry.refreshRuntimeProviders("online");
    assert.equal(next.registry.find("power-copilot", "fixture-responses")?.contextWindow, 10000);
    next.registry.clearSourceRegistrations("cache-restart-fixture");
  } finally { next.auth.close(); }
});
