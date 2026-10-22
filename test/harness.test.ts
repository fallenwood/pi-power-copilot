import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { BlockAssembler, LlmError, ReasoningEffortId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { createModels, InMemoryCredentialStore, type Credential, type OAuthCredential } from "@earendil-works/pi-ai";
import { Config, createHarnessRuntime } from "../src/harness.ts";

const ID = "power-copilot";
const BASE = "https://api.githubcopilot.com";
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const KEY = "synthetic-copilot-key";

function catalogModel(id = "responses-model", endpoint = "/responses", overrides: Record<string, unknown> = {}) {
  return {
    id, name: `Display ${id}`, model_picker_enabled: true,
    supported_endpoints: [endpoint],
    capabilities: {
      type: "chat",
      limits: { max_context_window_tokens: 10000, max_output_tokens: 2000 },
      supports: { vision: true, tool_calls: true, reasoning_effort: ["none", "low", "high"] },
    },
    ...overrides,
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
interface FetchCall { url: string; headers: Headers; body: Record<string, unknown> | undefined; signal: AbortSignal | null | undefined }
function intercept(t: TestContext, respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const rawBody = init?.body ?? (request ? await request.clone().text() : undefined);
    const call = {
      url: request?.url ?? String(input),
      headers: new Headers(init?.headers ?? request?.headers),
      body: typeof rawBody === "string" && rawBody ? JSON.parse(rawBody) as Record<string, unknown> : undefined,
      signal: init?.signal ?? request?.signal,
    };
    calls.push(call);
    return respond(call);
  });
  return calls;
}
async function stored(credential: Credential = { type: "api_key", key: KEY }) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(ID, async () => credential);
  return credentials;
}
function request(model = "responses-model", extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: ID, model, messages: [{ role: "user", content: [{ type: "text", text: "Hello fixture" }] }], ...extra };
}
async function consume(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  const assembled = new BlockAssembler();
  for await (const chunk of stream) { chunks.push(chunk); assembled.push(chunk); }
  return { chunks, assembled };
}
function sse(events: Record<string, unknown>[], done = false) {
  const data = events.map((event) => `event: ${String(event.type ?? "message")}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : "");
  // Deliberately split UTF-8 and SSE records across transport chunks. No SDK/adapter methods are mocked.
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream", "x-request-id": "fixture-request" } });
}
function responses(text = "Hello 世界", tool = false) {
  const item = tool
    ? { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "lookup", arguments: '{"city":"Paris"}', status: "completed" }
    : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return sse([
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "" } : { ...item, content: [] } },
    ...(tool ? [
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"city":' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '"Paris"}' },
    ] : [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: {
      input_tokens: 12, output_tokens: 3, total_tokens: 15,
      input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
    } } },
  ]);
}
function messages(text = "Hello 世界") {
  return sse([
    { type: "message_start", message: { id: "msg_anthropic_fixture", type: "message", role: "assistant", model: "messages-model", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]);
}
function completions(text = "Hello 世界") {
  return sse([
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "chat-model", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "chat-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ], true);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Every test is offline, including failure paths and lazy SDK imports.
test.beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request: this suite is offline"); });
});

test("Harness starts with an empty unauthenticated catalog and the real exported adapter", async () => {
  const runtime = createHarnessRuntime(new InMemoryCredentialStore());
  assert.ok(runtime.adapter instanceof PiAiAdapter);
  assert.equal(typeof createModels, "function");
  assert.deepEqual(runtime.adapter.providerInfo(ID), { id: ID, name: "Power Copilot" });
  assert.deepEqual(await runtime.adapter.listModels(ID), []);
  assert.deepEqual(runtime.models.getModels(ID), []);
  assert.deepEqual(runtime.provider.getModels(), []);
  await assert.rejects(runtime.adapter.resolveModel(ID, "invented-model"), (error) => error instanceof LlmError && error.code === "UNKNOWN_MODEL");
});

test("Harness API-key auth discovers all three dynamic APIs and exposes catalog metadata", async (t) => {
  const raw = [
    catalogModel("responses-model"),
    catalogModel("messages-model", "/messages"),
    catalogModel("chat-model", "/chat/completions", {
      capabilities: { type: "chat", limits: { max_context_window_tokens: 8000, max_output_tokens: 1000 }, supports: {} },
    }),
    catalogModel("hidden-model", "/responses", { model_picker_enabled: false }),
  ];
  const calls = intercept(t, ({ url, headers, signal }) => {
    assert.equal(url, `${BASE}/models`);
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.ok(signal instanceof AbortSignal);
    return json({ data: raw });
  });
  const runtime = createHarnessRuntime(await stored(), { "responses-model": 4096, "unknown-not-yet-discovered": 128 });
  const listed = await runtime.adapter.listModels(ID);
  assert.deepEqual(listed.map(({ id }) => id), ["responses-model", "messages-model", "chat-model"]);
  assert.deepEqual(listed[0], { provider: ID, id: "responses-model", name: "Display responses-model", inputModalities: ["text", "image"] });
  assert.deepEqual(runtime.provider.getModels().map(({ id, api, baseUrl, contextWindow, maxTokens }) => ({ id, api, baseUrl, contextWindow, maxTokens })), [
    { id: "responses-model", api: "openai-responses", baseUrl: BASE, contextWindow: 4096, maxTokens: 2000 },
    { id: "messages-model", api: "anthropic-messages", baseUrl: BASE, contextWindow: 10000, maxTokens: 2000 },
    { id: "chat-model", api: "openai-completions", baseUrl: BASE, contextWindow: 8000, maxTokens: 1000 },
  ]);
  for (const model of runtime.provider.getModels()) {
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.headers?.["Copilot-Integration-Id"], "vscode-chat");
    assert.equal(model.headers?.["Editor-Version"], "vscode/1.107.0");
  }
  const info = await runtime.adapter.resolveModel(ID, "responses-model");
  assert.equal(info.context?.contextWindow, 4096);
  assert.deepEqual(info.reasoning?.efforts.map(({ id }) => String(id)), ["off", "low", "high"]);
  assert.deepEqual(info.inputModalities, ["text", "image"]);
  const plain = await runtime.adapter.resolveModel(ID, "chat-model");
  assert.equal(plain.reasoning, undefined);
  assert.deepEqual(plain.inputModalities, ["text"]);
  assert.equal(calls.length, 1, "listing and metadata resolution share the TTL-cached catalog");
});

test("Harness Config rejects nonpositive, fractional, and unsafe context budgets", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => Config({ contextWindows: { model: value } }), String(value));
    assert.throws(() => createHarnessRuntime(new InMemoryCredentialStore(), { model: value }), /positive safe integer/);
  }
  const defaults = Config({});
  assert.equal(defaults.apiKeyEnv, "POWER_COPILOT_API_KEY");
  assert.equal(typeof defaults.contextWindows.get, "function");
  assert.deepEqual(defaults.contextWindows.get(), {});
  assert.equal(Config({ contextWindows: { model: 1 } }).contextWindows.get().model, 1);
  assert.equal(Config.dict!.contextWindows.meta.volatile, true);
});

for (const budget of [10000, 10001]) {
  test(`Harness rejects context override ${budget} at or above catalog capacity`, async (t) => {
    intercept(t, ({ url }) => { assert.equal(url, `${BASE}/models`); return json({ data: [catalogModel()] }); });
    const runtime = createHarnessRuntime(await stored(), { "responses-model": budget });
    await assert.rejects(runtime.adapter.listModels(ID), /must be less than.*10000.*refresh Power Copilot models/);
    assert.deepEqual(runtime.provider.getModels(), []);
  });
}

test("Harness renews OAuth once under concurrency and persists it for a new real Pi collection", async (t) => {
  const expired: OAuthCredential = {
    type: "oauth", authMethod: "github-oauth", refresh: "synthetic-github-grant", access: "expired-fixture", expires: 1,
    availableModelIds: ["previously-seen"],
  };
  const credentials = await stored(expired);
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const calls = intercept(t, ({ url, headers }) => {
    if (url === TOKEN_URL) {
      assert.equal(headers.get("authorization"), "Bearer synthetic-github-grant");
      return json({ token: "renewed-fixture", expires_at: expiry });
    }
    assert.equal(url, `${BASE}/models`);
    assert.equal(headers.get("authorization"), "Bearer renewed-fixture");
    return json({ data: [catalogModel()] });
  });
  const runtime = createHarnessRuntime(credentials);
  await Promise.all([runtime.adapter.listModels(ID), runtime.adapter.resolveModel(ID, "responses-model"), runtime.adapter.prepareCall(ID, "responses-model")]);
  assert.deepEqual(await credentials.read(ID), { ...expired, access: "renewed-fixture", expires: expiry * 1000 - 300000 });
  assert.equal(calls.filter(({ url }) => url === TOKEN_URL).length, 1);
  assert.equal(calls.filter(({ url }) => url.endsWith("/models")).length, 1);
  const nextModels = createModels({ credentials });
  nextModels.setProvider(createHarnessRuntime(credentials).provider);
  assert.equal((await nextModels.getAuth(ID))?.auth.apiKey, "renewed-fixture");
  assert.equal(calls.length, 2, "a fresh Models collection reuses the persisted renewal without a new exchange");
});

test("Harness OAuth enterprise renewal and discovery use the enterprise hosts", async (t) => {
  const credential: OAuthCredential = { type: "oauth", authMethod: "github-oauth", refresh: "synthetic-enterprise-grant", access: "expired", expires: 1, enterpriseUrl: "company.ghe.com" };
  const credentials = await stored(credential);
  const calls = intercept(t, ({ url, headers }) => {
    if (url === "https://api.company.ghe.com/copilot_internal/v2/token") {
      assert.equal(headers.get("authorization"), "Bearer synthetic-enterprise-grant");
      return json({ token: "renewed-enterprise", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    assert.equal(url, "https://api.enterprise.githubcopilot.com/models");
    assert.equal(headers.get("authorization"), "Bearer renewed-enterprise");
    return json({ data: [catalogModel()] });
  });
  const runtime = createHarnessRuntime(credentials);
  assert.equal((await runtime.adapter.listModels(ID)).length, 1);
  assert.equal(runtime.provider.getModels()[0]?.baseUrl, "https://api.enterprise.githubcopilot.com");
  const saved = await credentials.read(ID);
  assert.ok(saved?.type === "oauth");
  assert.equal(saved.enterpriseUrl, "company.ghe.com");
  assert.equal(calls.length, 2);
});

test("Harness token-routed API-key catalog follows proxy host without contacting public discovery", async (t) => {
  const key = "synthetic;proxy-ep=proxy.business.githubcopilot.com;signature=fixture";
  intercept(t, ({ url, headers }) => {
    assert.equal(url, "https://api.business.githubcopilot.com/models");
    assert.equal(headers.get("authorization"), `Bearer ${key}`);
    return json({ data: [catalogModel()] });
  });
  const runtime = createHarnessRuntime(await stored({ type: "api_key", key }));
  await runtime.adapter.listModels(ID);
  assert.equal(runtime.provider.getModels()[0]?.baseUrl, "https://api.business.githubcopilot.com");
});

test("failed catalog refresh preserves the previous publication and retries successfully", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let fail = false;
  let version = 1;
  const calls = intercept(t, ({ url }) => {
    assert.equal(url, `${BASE}/models`);
    return fail ? new Response("private provider detail must not leak", { status: 503 }) : json({ data: [catalogModel(`version-${version}`)] });
  });
  const runtime = createHarnessRuntime(await stored());
  await runtime.adapter.listModels(ID);
  const previous = runtime.provider.getModels();
  now += 300001;
  fail = true;
  await assert.rejects(runtime.adapter.listModels(ID), (error: Error) => /HTTP 503/.test(error.message) && !error.message.includes("private provider detail"));
  assert.deepEqual(runtime.provider.getModels(), previous, "a failed publication is atomic");
  assert.deepEqual(runtime.models.getModels(ID).map(({ id }) => id), ["version-1"]);
  fail = false;
  version = 2;
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["version-2"]);
  assert.equal(calls.length, 3);
});

test("failed OAuth renewal leaves the stored credential and old catalog intact for retry", async (t) => {
  const credential: OAuthCredential = { type: "oauth", authMethod: "github-oauth", refresh: "synthetic-github-grant", access: "initial-access", expires: Date.now() + 3600000 };
  const credentials = await stored(credential);
  let fail = true;
  intercept(t, ({ url }) => {
    if (url === TOKEN_URL) return fail ? new Response(null, { status: 503 }) : json({ token: "renewed-access", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal(url, `${BASE}/models`);
    return json({ data: [catalogModel()] });
  });
  const runtime = createHarnessRuntime(credentials);
  await runtime.adapter.listModels(ID);
  const previous = runtime.provider.getModels();
  const expired = { ...credential, expires: 1 };
  await credentials.modify(ID, async () => expired);
  await assert.rejects(runtime.adapter.listModels(ID), /OAuth refresh failed.*HTTP 503/);
  assert.deepEqual(await credentials.read(ID), expired);
  assert.equal(runtime.provider.getModels(), previous);
  fail = false;
  assert.equal((await runtime.adapter.listModels(ID)).length, 1);
});

test("changed authentication replaces old catalog immediately, including a new empty catalog", async (t) => {
  const credentials = await stored();
  intercept(t, ({ url, headers }) => {
    assert.equal(url, `${BASE}/models`);
    const key = headers.get("authorization");
    if (key === `Bearer ${KEY}`) return json({ data: [catalogModel("account-a-only")] });
    if (key === "Bearer account-b-key") return json({ data: [catalogModel("account-b-only")] });
    assert.equal(key, "Bearer empty-account-key");
    return json({ data: [] });
  });
  const runtime = createHarnessRuntime(credentials);
  await runtime.adapter.listModels(ID);
  await credentials.modify(ID, async () => ({ type: "api_key", key: "account-b-key" }));
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["account-b-only"]);
  await assert.rejects(runtime.adapter.resolveModel(ID, "account-a-only"), (error) => error instanceof LlmError && error.code === "UNKNOWN_MODEL");
  await credentials.modify(ID, async () => ({ type: "api_key", key: "empty-account-key" }));
  assert.deepEqual(await runtime.adapter.listModels(ID), []);
  await assert.rejects(runtime.adapter.prepareCall(ID, "account-b-only"), (error) => error instanceof LlmError && error.code === "UNKNOWN_MODEL");
});

for (const method of ["resolveModel", "prepareCall"] as const) {
  test(`logout does not leak the old catalog through ${method}`, async (t) => {
    intercept(t, ({ url }) => { assert.equal(url, `${BASE}/models`); return json({ data: [catalogModel("account-a-only")] }); });
    const credentials = await stored();
    const runtime = createHarnessRuntime(credentials);
    await runtime.adapter.listModels(ID);
    await credentials.delete(ID);
    assert.deepEqual(await runtime.adapter.listModels(ID), []);
    await assert.rejects(runtime.adapter[method](ID, "account-a-only"), (error) => error instanceof LlmError && ["UNKNOWN_MODEL", "MISSING_CREDENTIAL"].includes(error.code));
  });
}

test("an account change during discovery cannot publish the previous account catalog", async (t) => {
  const arrived = deferred<void>();
  const first = deferred<Response>();
  const credentials = await stored();
  intercept(t, ({ url, headers }) => {
    assert.equal(url, `${BASE}/models`);
    if (headers.get("authorization") === `Bearer ${KEY}`) { arrived.resolve(); return first.promise; }
    assert.equal(headers.get("authorization"), "Bearer account-b-key");
    return json({ data: [catalogModel("account-b-only")] });
  });
  const runtime = createHarnessRuntime(credentials);
  const listing = runtime.adapter.listModels(ID);
  await arrived.promise;
  await credentials.modify(ID, async () => ({ type: "api_key", key: "account-b-key" }));
  first.resolve(json({ data: [catalogModel("account-a-only")] }));
  // Refusing an obsolete operation is also safe; exposing account A is not.
  const result = await listing.catch(() => []);
  assert.ok(!result.some(({ id }) => id === "account-a-only"), "an in-flight account-A publication must not leak to account B");
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["account-b-only"]);
});

test("logout during discovery discards an already in-flight account catalog", async (t) => {
  const arrived = deferred<void>();
  const response = deferred<Response>();
  intercept(t, () => { arrived.resolve(); return response.promise; });
  const credentials = await stored();
  const runtime = createHarnessRuntime(credentials);
  const listing = runtime.adapter.listModels(ID);
  await arrived.promise;
  await credentials.delete(ID);
  response.resolve(json({ data: [catalogModel("account-a-only")] }));
  assert.deepEqual(await listing, []);
  await assert.rejects(runtime.adapter.resolveModel(ID, "account-a-only"), (error) => error instanceof LlmError && ["UNKNOWN_MODEL", "MISSING_CREDENTIAL"].includes(error.code));
});

test("failed discovery for a replacement account hides the previous adapter catalog", async (t) => {
  const credentials = await stored();
  intercept(t, ({ headers }) => headers.get("authorization") === `Bearer ${KEY}`
    ? json({ data: [catalogModel("account-a-only")] }) : new Response(null, { status: 503 }));
  const runtime = createHarnessRuntime(credentials);
  await runtime.adapter.listModels(ID);
  await credentials.modify(ID, async () => ({ type: "api_key", key: "account-b-key" }));
  await assert.rejects(runtime.adapter.listModels(ID), /HTTP 503/);
  assert.throws(() => runtime.adapter.imageRequestTarget(ID, "account-a-only", {} as never), (error) => error instanceof LlmError && error.code === "UNKNOWN_MODEL");
});

test("OAuth access-token rotation keeps the same account catalog cached and streams with the renewed token", async (t) => {
  const original: OAuthCredential = { type: "oauth", authMethod: "github-oauth", refresh: "fixture-same-account", access: "initial-fixture-access", expires: Date.now() + 3600000 };
  const credentials = await stored(original);
  const calls = intercept(t, ({ url, headers }) => {
    if (url === TOKEN_URL) return json({ token: "renewed-fixture-access", expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (url === `${BASE}/models`) {
      assert.equal(headers.get("authorization"), "Bearer initial-fixture-access");
      return json({ data: [catalogModel()] });
    }
    assert.equal(url, `${BASE}/responses`);
    assert.equal(headers.get("authorization"), "Bearer renewed-fixture-access");
    return responses();
  });
  const runtime = createHarnessRuntime(credentials);
  await runtime.adapter.listModels(ID);
  await credentials.modify(ID, async () => ({ ...original, expires: 1 }));
  const result = await consume(runtime.adapter.stream(request()));
  assert.equal(result.assembled.finish.kind, "stop");
  assert.equal(calls.filter(({ url }) => url.endsWith("/models")).length, 1);
  assert.equal(calls.filter(({ url }) => url === TOKEN_URL).length, 1);
});

test("pre-aborted metadata, prepared call, and stream requests perform no fetch", async () => {
  const runtime = createHarnessRuntime(await stored());
  const controller = new AbortController();
  const reason = new Error("fixture request withdrawn before start");
  controller.abort(reason);
  await assert.rejects(runtime.adapter.resolveModel(ID, "responses-model", controller.signal), (error) => error === reason);
  await assert.rejects(runtime.adapter.prepareCall(ID, "responses-model", controller.signal), (error) => error === reason);
  await assert.rejects(consume(runtime.adapter.stream(request("responses-model", { signal: controller.signal }))), (error) => error === reason);
});

test("one caller can cancel a shared catalog refresh without cancelling another", async (t) => {
  const arrived = deferred<void>();
  const response = deferred<Response>();
  const calls = intercept(t, ({ signal }) => {
    assert.equal(signal?.aborted, false);
    arrived.resolve();
    return response.promise;
  });
  const runtime = createHarnessRuntime(await stored());
  const controller = new AbortController();
  const reason = new Error("fixture caller cancelled");
  const cancelled = runtime.adapter.resolveModel(ID, "responses-model", controller.signal);
  const rejected = assert.rejects(cancelled, (error) => error === reason);
  const survivor = runtime.adapter.listModels(ID);
  await arrived.promise;
  controller.abort(reason);
  await rejected;
  response.resolve(json({ data: [catalogModel()] }));
  assert.equal((await survivor).length, 1);
  assert.equal(calls.length, 1);
});

for (const [model, endpoint, api, fixture] of [
  ["responses-model", "/responses", "openai-responses", responses],
  ["messages-model", "/messages", "anthropic-messages", messages],
  ["chat-model", "/chat/completions", "openai-completions", completions],
] as const) {
  test(`real PiAiAdapter streaming ${endpoint} sends Bearer auth and consumes fragmented SSE`, async (t) => {
    const calls = intercept(t, ({ url, headers, body, signal }) => {
      assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
      assert.equal(headers.get("x-api-key"), null, "Copilot must never receive Anthropic x-api-key auth");
      assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
      if (url === `${BASE}/models`) return json({ data: [catalogModel(model, endpoint)] });
      // Anthropic SDK owns the /v1 prefix and beta query; Copilot advertises /messages.
      assert.equal(url, endpoint === "/messages" ? `${BASE}/v1/messages?beta=true` : `${BASE}${endpoint}`);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(body?.model, model);
      assert.equal(body?.stream, true);
      assert.ok(JSON.stringify(body).includes("Hello fixture"));
      return fixture();
    });
    const runtime = createHarnessRuntime(await stored());
    const { chunks, assembled } = await consume(runtime.adapter.stream(request(model, { maxTokens: 256 })));
    assert.equal(assembled.finish.kind, "stop", JSON.stringify({ finish: chunks.at(-1), requests: calls.map(({ url, headers, body }) => ({ url, headers: Object.fromEntries(headers), body })) }));
    assert.deepEqual(assembled.blocks(), [{ type: "text", text: "Hello 世界" }]);
    assert.ok((assembled.usage?.inputTokens ?? 0) > 0);
    assert.equal(assembled.usage?.outputTokens, 3);
    assert.equal(chunks.at(-2)?.type, "usage");
    assert.equal(chunks.at(-1)?.type, "finish");
    assert.ok(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text.includes("世界")));
    assert.deepEqual(assembled.replayState?.response, {
      kind: "pi-ai", version: 2, api, provider: ID, model,
      responseId: api === "openai-responses" ? "resp_fixture" : api === "anthropic-messages" ? "msg_anthropic_fixture" : "chatcmpl_fixture",
      stopReason: "stop",
    });
    assert.equal(calls.length, 2);
  });
}

test("real responses tool-call streaming and durable replay preserve arguments and tool results", async (t) => {
  let turn = 0;
  const calls = intercept(t, ({ url, body }) => {
    if (url === `${BASE}/models`) return json({ data: [catalogModel()] });
    assert.equal(url, `${BASE}/responses`);
    if (++turn === 1) {
      assert.deepEqual(body?.reasoning, { effort: "low", summary: "auto" });
      assert.ok(Array.isArray(body?.tools) && body.tools.some((tool: Record<string, unknown>) => tool.name === "lookup"));
      return responses("", true);
    }
    assert.ok(Array.isArray(body?.input));
    const input = body.input as Record<string, unknown>[];
    const call = input.find((item) => item.type === "function_call");
    assert.equal(call?.name, "lookup");
    assert.equal(call?.call_id, "call_fixture");
    assert.deepEqual(JSON.parse(String(call?.arguments)), { city: "Paris" });
    assert.ok(input.some((item) => item.type === "function_call_output" && item.call_id === "call_fixture" && item.output === "Sunny"));
    return responses("It is sunny");
  });
  const runtime = createHarnessRuntime(await stored());
  const tools = [{ name: "lookup", description: "Fixture lookup", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
  const first = await consume(runtime.adapter.stream(request("responses-model", { tools, reasoningEffort: ReasoningEffortId("low") })));
  assert.equal(first.assembled.finish.kind, "tool-calls");
  const tool = first.assembled.blocks()[0];
  assert.ok(tool?.type === "tool-call");
  assert.equal(tool.name, "lookup");
  assert.deepEqual(JSON.parse(tool.arguments), { city: "Paris" });
  const assistant = first.assembled.message({ provider: ID, model: "responses-model", replayState: first.assembled.replayState });
  assert.ok(assistant.source.replayState);
  const next = request("responses-model", {
    tools,
    messages: [
      ...request().messages, assistant,
      { id: "tool-result-fixture" as never, role: "tool", source: { kind: "tool", callId: tool.id }, toolCallId: tool.id, content: [{ type: "text", text: "Sunny" }] },
    ],
  });
  const second = await consume(runtime.adapter.stream(next));
  assert.deepEqual(second.assembled.blocks(), [{ type: "text", text: "It is sunny" }]);
  assert.equal(second.assembled.finish.kind, "stop");
  assert.equal(calls.length, 3);
});

test("prepareCall freezes catalog metadata and API transport while later calls use a refreshed catalog", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let version = 1;
  const transports: string[] = [];
  intercept(t, ({ url }) => {
    if (url === `${BASE}/models`) return json({ data: [catalogModel("stable-model", version === 1 ? "/responses" : "/chat/completions", {
      name: `Version ${version}`,
      capabilities: { type: "chat", limits: { max_context_window_tokens: version === 1 ? 10000 : 12000, max_output_tokens: 2000 }, supports: {} },
    })] });
    transports.push(url);
    if (url === `${BASE}/responses`) return responses("old snapshot");
    assert.equal(url, `${BASE}/chat/completions`);
    return completions("new snapshot");
  });
  const runtime = createHarnessRuntime(await stored());
  const prepared = await runtime.adapter.prepareCall(ID, "stable-model");
  assert.equal(prepared.model.name, "Version 1");
  version = 2;
  now += 300001;
  const current = await runtime.adapter.resolveModel(ID, "stable-model");
  assert.equal(current.name, "Version 2");
  assert.equal(current.context?.contextWindow, 12000);
  assert.equal(prepared.model.context?.contextWindow, 10000);
  const old = await consume(prepared.stream(request("stable-model")));
  assert.deepEqual(old.assembled.blocks(), [{ type: "text", text: "old snapshot" }]);
  const fresh = await consume(runtime.adapter.stream(request("stable-model")));
  assert.deepEqual(fresh.assembled.blocks(), [{ type: "text", text: "new snapshot" }]);
  assert.deepEqual(transports, [`${BASE}/responses`, `${BASE}/chat/completions`]);
});

test("live context-window getters refresh effective metadata without mutating prepared snapshots", async (t) => {
  let windows: Record<string, number> = { "responses-model": 4096 };
  const calls = intercept(t, ({ url }) => url === `${BASE}/models` ? json({ data: [catalogModel()] }) : responses("prepared window"));
  const runtime = createHarnessRuntime(await stored(), () => windows);
  const prepared = await runtime.adapter.prepareCall(ID, "responses-model");
  assert.equal(prepared.model.context?.contextWindow, 4096);
  windows = { "responses-model": 8192 };
  assert.equal((await runtime.adapter.resolveModel(ID, "responses-model")).context?.contextWindow, 8192);
  assert.equal(prepared.model.context?.contextWindow, 4096);
  assert.equal(calls.filter(({ url }) => url.endsWith("/models")).length, 2, "a live window edit invalidates the catalog before TTL expiry");
  const result = await consume(prepared.stream(request()));
  assert.deepEqual(result.assembled.blocks(), [{ type: "text", text: "prepared window" }]);
  assert.equal(prepared.model.context?.contextWindow, 4096);
  windows = {};
  assert.equal((await runtime.adapter.resolveModel(ID, "responses-model")).context?.contextWindow, 10000);
  assert.equal(calls.filter(({ url }) => url.endsWith("/models")).length, 3, "removing an override restores the service maximum");
  await runtime.adapter.resolveModel(ID, "responses-model");
  assert.equal(calls.filter(({ url }) => url.endsWith("/models")).length, 3);
});

test("a context-window getter changed during discovery cannot publish obsolete effective windows", async (t) => {
  let windows: Record<string, number> = { "responses-model": 4096 };
  const entered = deferred<void>();
  const initial = deferred<Response>();
  let requests = 0;
  intercept(t, ({ url }) => {
    assert.equal(url, `${BASE}/models`);
    if (++requests === 1) { entered.resolve(); return initial.promise; }
    return json({ data: [catalogModel()] });
  });
  const runtime = createHarnessRuntime(await stored(), () => windows);
  const listing = runtime.adapter.resolveModel(ID, "responses-model");
  await entered.promise;
  windows = { "responses-model": 7168 };
  initial.resolve(json({ data: [catalogModel()] }));
  assert.equal((await listing).context?.contextWindow, 7168);
  assert.equal(requests, 2);
});

test("live window identity ignores dictionary insertion order and rejects invalid edits explicitly", async (t) => {
  let windows: Record<string, number> = { "responses-model": 4096, "future-model": 100 };
  const calls = intercept(t, () => json({ data: [catalogModel()] }));
  const runtime = createHarnessRuntime(await stored(), () => windows);
  await runtime.adapter.listModels(ID);
  windows = { "future-model": 100, "responses-model": 4096 };
  assert.equal((await runtime.adapter.resolveModel(ID, "responses-model")).context?.contextWindow, 4096);
  assert.equal(calls.length, 1, "only semantic changes invalidate the catalog");
  windows = { "responses-model": 0 };
  await assert.rejects(runtime.adapter.listModels(ID), /positive safe integer/);
  windows = { "responses-model": 10000 };
  await assert.rejects(runtime.adapter.listModels(ID), /must be less than.*10000/);
  windows = { "responses-model": 2048 };
  assert.equal((await runtime.adapter.resolveModel(ID, "responses-model")).context?.contextWindow, 2048);
});

test("explicit runtime reload bypasses fresh catalog cache and coalesces concurrent refreshes", async (t) => {
  let version = 1;
  let hold = false;
  const entered = deferred<void>();
  const response = deferred<Response>();
  const calls = intercept(t, () => {
    if (hold) { entered.resolve(); return response.promise; }
    return json({ data: [catalogModel(`version-${version}`)] });
  });
  const runtime = createHarnessRuntime(await stored());
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["version-1"]);
  version = 2;
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["version-1"]);
  assert.equal(calls.length, 1);
  await runtime.reload();
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["version-2"]);
  assert.equal(calls.length, 2);
  hold = true;
  const reloads = [runtime.reload(), runtime.reload()];
  await entered.promise;
  response.resolve(json({ data: [catalogModel("version-3")] }));
  await Promise.all(reloads);
  assert.deepEqual((await runtime.adapter.listModels(ID)).map(({ id }) => id), ["version-3"]);
  assert.equal(calls.length, 3);
});

for (const mode of ["direct", "prepared"] as const) {
  test(`runtime disposal aborts an active real ${mode} Responses SSE request`, { timeout: 3000 }, async (t) => {
    const textArrived = deferred<void>();
    const chunks: StreamChunk[] = [];
    let httpSignal: AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyAborted = false;
    const caller = new AbortController();
    intercept(t, ({ url, headers, signal }) => {
      if (url === `${BASE}/models`) return json({ data: [catalogModel()] });
      assert.equal(url, `${BASE}/responses`);
      assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
      assert.ok(signal instanceof AbortSignal);
      httpSignal = signal;
      const events = [
        { type: "response.created", response: { id: "resp_unfinished", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { id: "msg_unfinished", type: "message", role: "assistant", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "before disposal" },
      ];
      // A mocked fetch must explicitly bind its body to the supplied HTTP signal,
      // just as real fetch does. Without the runtime's lifetime composition this
      // connection remains open and the test times out rather than passing.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
          signal.addEventListener("abort", () => {
            bodyAborted = true;
            controller.error(signal.reason);
          }, { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    // Cleanup also releases a hanging reader if a future regression triggers the timeout.
    t.after(() => bodyController?.error(new Error("fixture cleanup")));
    const runtime = createHarnessRuntime(await stored());
    const prepared = mode === "prepared" ? await runtime.adapter.prepareCall(ID, "responses-model") : undefined;
    const stream = prepared ? prepared.stream(request("responses-model", { signal: caller.signal }))
      : runtime.adapter.stream(request("responses-model", { signal: caller.signal }));
    const consuming = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk);
        if (chunk.type === "text-delta") textArrived.resolve();
      }
    })();
    await textArrived.promise;
    assert.ok(httpSignal);
    assert.equal(httpSignal.aborted, false);
    assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").length, 1);
    runtime.dispose();
    assert.equal(httpSignal.aborted, true, "plugin unload reaches the actual HTTP request signal");
    assert.equal(bodyAborted, true);
    assert.equal(caller.signal.aborted, false, "the composed lifetime does not mutate caller cancellation");
    await consuming;
    assert.deepEqual(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text), ["before disposal"]);
    const finish = chunks.at(-1);
    assert.ok(finish?.type === "finish", JSON.stringify(chunks));
    assert.equal(finish.reason.kind, "aborted", JSON.stringify(finish));
    assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 1);
  });
}
