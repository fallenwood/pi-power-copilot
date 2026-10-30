import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { createOmpPowerCopilotProvider } from "../src/omp-provider.ts";
import { COPILOT_REQUEST_HEADERS } from "../src/copilot-headers.ts";

function config(t: test.TestContext, content?: string) {
  const dir = mkdtempSync(join(tmpdir(), "power-copilot-omp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "power-copilot.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

function callbacks(answers: string[], signal = new AbortController().signal) {
  const prompts: Array<Parameters<OAuthLoginCallbacks["onPrompt"]>[0]> = [];
  const notices: Array<Parameters<OAuthLoginCallbacks["onAuth"]>[0]> = [];
  const interaction: OAuthLoginCallbacks = {
    signal,
    onAuth(info) { notices.push(info); },
    async onPrompt(prompt) {
      prompts.push(prompt);
      assert.ok(answers.length, "Unexpected prompt");
      return answers.shift()!;
    },
  };
  return { interaction, prompts, notices };
}

function model(id: string, endpoint: string, supports = {}) {
  return { id, name: id, supported_endpoints: [endpoint], capabilities: {
    type: "chat", limits: { max_context_window_tokens: 10000, max_output_tokens: 2000 }, supports,
  } };
}

for (const [domain, baseUrl] of [
  ["", "https://api.githubcopilot.com"],
  ["company.ghe.com", "https://api.enterprise.githubcopilot.com"],
] as const) {
  test(`OMP OAuth device login, restart discovery, and renewal route ${domain || "github.com"}`, async (t) => {
    const path = config(t);
    const provider = createOmpPowerCopilotProvider(path);
    const { interaction, prompts, notices } = callbacks(["", domain]);
    const requests: string[] = [];
    let exchanges = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      assert.ok(init?.signal instanceof AbortSignal);
      if (url.endsWith("/login/device/code")) return Response.json({
        device_code: "private-device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device",
        interval: 0, expires_in: 60,
      });
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "private-github" });
      if (url.endsWith("/copilot_internal/v2/token")) {
        assert.equal(url, `https://api.${domain || "github.com"}/copilot_internal/v2/token`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-github");
        return Response.json({ token: `private-copilot-${++exchanges}`, expires_at: 2_000_000_000 });
      }
      assert.equal(url, `${baseUrl}/models`);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-copilot-1");
      return Response.json({ data: [model("live-model", "/responses")] });
    });

    const credential = await provider.oauth!.login(interaction);
    assert.notEqual(typeof credential, "string");
    const saved = credential as OAuthCredentials;
    assert.equal(provider.oauth!.getApiKey!(saved), "private-copilot-1");
    assert.equal(saved.refresh, "private-github");
    assert.equal(saved.expires, 2_000_000_000_000 - 300000);
    assert.deepEqual(prompts.map(({ secret }) => secret), [undefined, undefined]);
    assert.deepEqual(notices, [{ url: "https://github.com/login/device", instructions: "Enter code: ABCD-EFGH" }]);
    assert.doesNotMatch(JSON.stringify({ prompts, notices }), /private-/);

    // OMP discovery reads stored access without invoking getApiKey, even after restart.
    const next = createOmpPowerCopilotProvider(path);
    const catalog = await next.fetchDynamicModels!(JSON.parse(JSON.stringify(saved)).access);
    assert.equal(catalog[0].id, "live-model");
    assert.equal((catalog[0] as { baseUrl?: string }).baseUrl, baseUrl);
    const beforeRefresh = requests.length;
    const renewed = await next.oauth!.refreshToken!(saved);
    assert.equal(next.oauth!.getApiKey!(renewed), "private-copilot-2");
    assert.equal(renewed.refresh, saved.refresh);
    assert.deepEqual(requests.slice(beforeRefresh), [`https://api.${domain || "github.com"}/copilot_internal/v2/token`]);
  });
}

test("OMP API-key login requests masked input and never starts OAuth", async (t) => {
  const provider = createOmpPowerCopilotProvider(config(t));
  const { interaction, prompts, notices } = callbacks(["api-key", " private-key "]);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  assert.equal(await provider.oauth!.login(interaction), "private-key");
  assert.equal(prompts[1].secret, true);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(notices, []);
  await assert.rejects(provider.oauth!.login(callbacks(["api-key", "  "]).interaction), /API key is required/);
  await assert.rejects(provider.oauth!.login(callbacks(["unknown"]).interaction), /Unknown.*method/);
});

test("OMP discovery preserves protocols and translates advertised reasoning and context limits", async (t) => {
  const provider = createOmpPowerCopilotProvider(config(t, JSON.stringify({ contextWindows: { responses: 1234 } })));
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://api.business.githubcopilot.com/models");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer raw;proxy-ep=proxy.business.githubcopilot.com");
    for (const [name, value] of Object.entries(COPILOT_REQUEST_HEADERS)) assert.equal(headers.get(name), value);
    return Response.json({ data: [
      model("responses", "/responses", { vision: true, reasoning_effort: ["none", "low", "high"] }),
      model("messages", "/messages", { reasoning_effort: ["medium", "high", "max"] }),
      model("chat", "/chat/completions"),
      { ...model("hidden", "/responses"), model_picker_enabled: false },
      model("unsupported", "/embeddings"),
    ] });
  });
  const models = await provider.fetchDynamicModels!("raw;proxy-ep=proxy.business.githubcopilot.com");
  assert.deepEqual(models.map(({ api }) => api), [
    "power-copilot-openai-responses", "power-copilot-anthropic-messages", "power-copilot-openai-completions",
  ]);
  assert.ok(models.every((entry) => !("headers" in entry)), "request headers must not invalidate OMP's disk cache");
  assert.deepEqual(models.map(({ contextWindow }) => contextWindow), [1234, 10000, 10000]);
  assert.deepEqual(models.map(({ maxTokens }) => maxTokens), [2000, 2000, 2000]);
  assert.deepEqual(models[0].thinking, { mode: "effort", efforts: ["low", "high"] });
  assert.deepEqual(models[1].thinking, { mode: "anthropic-adaptive", efforts: ["medium", "high", "max"] });
  assert.equal(models[2].thinking, undefined);
  assert.equal(models[2].reasoning, false);
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.ok(models.every((entry) => !("thinkingLevelMap" in entry)));
});

test("OMP rejects invalid configuration and credentials without leaking tokens or response bodies", async (t) => {
  assert.throws(() => createOmpPowerCopilotProvider(config(t, "{")), /JSON/);
  assert.throws(() => createOmpPowerCopilotProvider(config(t, '{"contextWindows":{"one":0}}')), /positive safe integer/);
  const provider = createOmpPowerCopilotProvider(config(t, '{"contextWindows":{"one":10000}}'));
  await assert.rejects(provider.fetchDynamicModels!(undefined), /Sign in/);
  await assert.rejects(provider.fetchDynamicModels!("power-copilot-oauth-v1:private-broken"), (error: Error) => {
    assert.match(error.message, /Invalid.*credential/);
    assert.doesNotMatch(error.message, /private-broken/);
    return true;
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [model("one", "/responses")] }));
  await assert.rejects(provider.fetchDynamicModels!("private-key"), /restart OMP and refresh models/);
  t.mock.method(globalThis, "fetch", async () => new Response("private-response", { status: 403 }));
  await assert.rejects(provider.fetchDynamicModels!("private-key"), (error: Error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /private-/);
    return true;
  });
});

test("OMP login and renewal honor cancellation before network activity", async (t) => {
  const provider = createOmpPowerCopilotProvider(config(t));
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  await assert.rejects(provider.oauth!.login(callbacks([], controller.signal).interaction), (error) => error === reason);
  // The host can pass a signal although its ProviderConfig declaration omits it.
  await assert.rejects(Reflect.apply(provider.oauth!.refreshToken!, undefined, [
    { refresh: "private-github", access: "private-old", expires: 1 }, controller.signal,
  ]), (error) => error === reason);
  assert.equal(fetchMock.mock.callCount(), 0);
});
