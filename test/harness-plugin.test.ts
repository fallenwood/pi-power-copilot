import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import AuthorizationService from "@deepseek-ai/dsh-authorization";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import type { CredentialKey, CredentialRecord } from "@deepseek-ai/dsh-credentials";
import type { LlmAdapter, LlmConfigurableProvider } from "@deepseek-ai/dsh-llm";
import * as plugin from "../src/harness.ts";
import { HARNESS_CREDENTIAL_KEY } from "../src/harness-auth.ts";
import { HARNESS_SETTINGS_PATH } from "../src/harness-settings.ts";

const BASE = "https://api.githubcopilot.com";
const NS = "include:fixture-power-copilot";
const API_KEY = "synthetic-settings-api-key";
const GITHUB_TOKEN = "synthetic-settings-github-token";
const COPILOT_TOKEN = "synthetic-settings-copilot-token";
const SECRETS = [API_KEY, GITHUB_TOKEN, COPILOT_TOKEN];
interface Status {
  settingsNs: string;
  configured: boolean;
  credentialSource: "saved" | "reference" | null;
  authType: "api_key" | "oauth" | null;
  warning?: "models-unavailable";
  attempt: { id: string; status: "pending" | "authorized" | "cancelled" | "error";
    notice?: { message: string; url?: string; code?: string }; error?: string } | null;
}
function json(value: unknown, code = 200) { return Response.json(value, { status: code }); }
function catalog(version = "fixture-model") {
  return { data: [{ id: version, name: version, supported_endpoints: ["/responses"],
    capabilities: { type: "chat", limits: { max_context_window_tokens: 10000, max_output_tokens: 2000 } } }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  assert.ok(signal);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
function network(t: TestContext, respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return respond(url, init);
  });
  return calls;
}

/** Real Cordis and AuthorizationService; the transport fixture models only exact owner-route admission. */
async function fixture(t: TestContext, settingsNs: string | null = NS) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const records = new Map<CredentialKey, CredentialRecord>();
  const references = new Map<string, string>();
  const commits: CredentialRecord[] = [];
  ctx.provide("credentials", {
    readRecord: async (key: CredentialKey) => structuredClone(records.get(key)),
    describeRecord: async (key: CredentialKey) => ({ configured: records.has(key), kind: records.get(key)?.kind, writable: true }),
    listRecords: async () => [...records].map(([key, record]) => ({ key, kind: record.kind })),
    async modifyRecord(key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(structuredClone(records.get(key)));
      if (next !== undefined) {
        records.set(key, structuredClone(next)); commits.push(structuredClone(next)); ctx.emit("credentials/record-updated", key);
      }
      return structuredClone(records.get(key));
    },
    async deleteRecord(key: CredentialKey) { records.delete(key); ctx.emit("credentials/record-updated", key); },
    resolve: async (ref: string) => references.has(ref) ? { value: references.get(ref), source: "fixture" } : undefined,
  });
  let adapter: LlmAdapter | undefined;
  let directory: readonly LlmConfigurableProvider[] | undefined;
  const replacements: (readonly LlmConfigurableProvider[])[] = [];
  ctx.provide("llm", {
    registerAdapter(routes: string[], next: LlmAdapter) {
      assert.deepEqual(routes, ["power-copilot"]);
      adapter = next;
      return () => { adapter = undefined; };
    },
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]) {
      directory = structuredClone(entries);
      const remove = () => { directory = undefined; };
      return Object.assign(remove, { replace(next: readonly LlmConfigurableProvider[]) {
        directory = structuredClone(next); replacements.push(structuredClone(next));
      } });
    },
  });
  const routes = new Map<string, ConnectionFetchRoute>();
  const registered: ConnectionFetchRoute[] = [];
  ctx.provide("connection", { fetch: { register(route: ConnectionFetchRoute) {
    assert.equal(routes.has(route.path), false);
    routes.set(route.path, route); registered.push(route);
    return async () => { routes.delete(route.path); };
  } } });
  // These traps prove the Settings integration does not depend on any command/question registration.
  ctx.provide("commands", { register() { assert.fail("Settings provider must not register slash commands"); } });
  ctx.provide("userQuestions", { ask() { assert.fail("Settings authorization must not ask an agent question"); } });
  await ctx.plugin(AuthorizationService);
  const mounted = { ...plugin, apply(child: Context, config: plugin.Config) {
    if (settingsNs !== null) child.fiber.entry = { options: { id: settingsNs } } as unknown as Entry;
    plugin.apply(child, config);
  } };
  const fiber = await ctx.plugin(mounted, {});
  const handler = routes.get(HARNESS_SETTINGS_PATH)!.fetch;
  assert.ok(handler, "the connection exact owner-route is installed");
  async function send(body?: unknown, options: { method?: string; text?: string; contentType?: string } = {}) {
    const request = new Request(`http://127.0.0.1:3080${HARNESS_SETTINGS_PATH}`, body === undefined && options.text === undefined
      ? { method: options.method ?? "GET" }
      : { method: options.method ?? "POST", headers: { "content-type": options.contentType ?? "application/json" },
          body: options.text ?? JSON.stringify(body) });
    const response = await handler(request);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    for (const secret of SECRETS) assert.ok(!text.includes(secret), "browser responses must not contain submitted or exchanged tokens");
    return { code: response.status, body: JSON.parse(text) as Status & { error?: string }, text };
  }
  async function settled() {
    for (let turn = 0; turn < 100; turn++) {
      // Authorization and its model reload are separate async stages. Let the
      // synthetic fetch/Response microtasks drain before checking terminal state.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = await send();
      if (result.body.attempt?.status !== "pending") return result;
    }
    assert.fail("synthetic authorization did not settle");
  }
  return { ctx, records, references, commits, routes, registered, fiber, replacements,
    adapter: () => adapter, directory: () => directory, send, settled };
}

test.beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Settings suite must not access real network endpoints"); });
});

test("Cordis registers the Models provider with its real entry namespace and an exact owner-only Fetch route", async (t) => {
  const f = await fixture(t);
  assert.ok(f.adapter());
  assert.deepEqual(f.directory(), [{ provider: "power-copilot", displayName: "Power Copilot", settingsNs: NS, settingsPath: [],
    nativeAuth: { env: ["POWER_COPILOT_API_KEY"], oauth: true } }]);
  assert.deepEqual(f.registered.map(({ path, methods, requestBody }) => ({ path, methods, requestBody })), [
    { path: "/api/power-copilot", methods: ["GET", "POST"], requestBody: "buffered" },
  ]);
  assert.equal(plugin.Config.dict!.contextWindows.meta.volatile, true);
  assert.deepEqual(plugin.Config({}).contextWindows.get(), {});
  assert.deepEqual(await f.adapter()!.listModels("power-copilot"), []);
  assert.deepEqual((await f.send()).body, { settingsNs: NS, configured: false, credentialSource: null, authType: null, attempt: null });
  assert.deepEqual(f.ctx.authorization.describe(HARNESS_CREDENTIAL_KEY)?.methods.map(({ id }) => id), ["oauth", "api-key"]);
  await f.fiber.dispose();
  assert.equal(f.adapter(), undefined); assert.equal(f.directory(), undefined); assert.equal(f.routes.size, 0);
  assert.equal(f.ctx.authorization.describe(HARNESS_CREDENTIAL_KEY), undefined);
  assert.equal((await f.send()).code, 503, "a retained handler cannot operate after unload");
});

test("Settings provider uses the standalone namespace when no Loader entry exists", async (t) => {
  const f = await fixture(t, null);
  assert.equal(f.directory()?.[0]?.settingsNs, "power-copilot");
  assert.deepEqual(f.directory()?.[0]?.settingsPath, []);
  assert.equal((await f.send()).body.settingsNs, "power-copilot");
});

test("HTTP API-key sign-in commits once, exposes no token, refreshes the picker, and logout is idempotent", async (t) => {
  const modelRequest = deferred<void>();
  const response = deferred<Response>();
  let hold = true;
  let version = 1;
  const calls = network(t, (url, init) => {
    assert.equal(url, `${BASE}/models`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${API_KEY}`);
    if (hold) { modelRequest.resolve(); return response.promise; }
    return json(catalog(`model-${version}`));
  });
  const f = await fixture(t);
  const first = await f.send({ action: "begin", method: "api-key", apiKey: `  ${API_KEY}  ` });
  assert.equal(first.code, 200);
  await modelRequest.promise;
  assert.equal((await f.send()).body.attempt?.status, "pending", "the browser must keep polling until model reload and directory notification complete");
  const duplicate = await f.send({ action: "begin", method: "api-key", apiKey: API_KEY });
  assert.equal(duplicate.code, 409); assert.equal(duplicate.body.error, "already-running");
  assert.equal(f.commits.length, 1);
  hold = false; response.resolve(json(catalog("model-1")));
  const authorized = await f.settled();
  assert.equal(authorized.body.attempt?.status, "authorized"); assert.equal(authorized.body.authType, "api_key");
  assert.equal(authorized.body.configured, true); assert.equal(authorized.body.credentialSource, "saved");
  assert.deepEqual(f.records.get(HARNESS_CREDENTIAL_KEY), { kind: "api-key", key: API_KEY });
  assert.equal(f.replacements.length, 1);
  assert.deepEqual((await f.adapter()!.listModels("power-copilot")).map(({ id }) => id), ["model-1"]);
  assert.equal(calls.length, 1);
  version = 2;
  assert.equal((await f.send({ action: "refresh" })).code, 200);
  assert.deepEqual((await f.adapter()!.listModels("power-copilot")).map(({ id }) => id), ["model-2"]);
  assert.equal(calls.length, 2, "explicit refresh bypasses the five-minute catalog cache");
  for (let repeat = 0; repeat < 2; repeat++) {
    const logout = await f.send({ action: "logout" });
    assert.equal(logout.code, 200); assert.equal(logout.body.configured, false); assert.equal(logout.body.attempt, null);
  }
  assert.equal(f.records.has(HARNESS_CREDENTIAL_KEY), false);
  assert.deepEqual(await f.adapter()!.listModels("power-copilot"), []);
});

test("HTTP OAuth exposes only the device URL/code and persists the grant after completion", async (t) => {
  const polling = deferred<void>();
  const grant = deferred<Response>();
  network(t, (url) => {
    if (url === "https://github.com/login/device/code") return json({ device_code: "fixture-device-secret", user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device", interval: 0, expires_in: 60 });
    if (url === "https://github.com/login/oauth/access_token") { polling.resolve(); return grant.promise; }
    if (url.endsWith("/copilot_internal/v2/token")) return json({ token: COPILOT_TOKEN, expires_at: 2_000_000_000 });
    assert.equal(url, `${BASE}/models`); return json(catalog());
  });
  const f = await fixture(t);
  const begin = await f.send({ action: "begin", method: "oauth" });
  assert.equal(begin.code, 200); assert.equal(begin.body.attempt?.status, "pending");
  await polling.promise;
  const pending = await f.send();
  assert.deepEqual(pending.body.attempt?.notice, { message: "Enter this code on the verification page to sign in to Power Copilot.",
    url: "https://github.com/login/device", code: "ABCD-EFGH" });
  assert.ok(!pending.text.includes("fixture-device-secret"));
  grant.resolve(json({ access_token: GITHUB_TOKEN }));
  const done = await f.settled();
  assert.equal(done.body.attempt?.status, "authorized"); assert.equal(done.body.authType, "oauth");
  const record = f.records.get(HARNESS_CREDENTIAL_KEY);
  assert.equal(record?.kind, "grant");
  assert.equal((record as { payload: { access: string } }).payload.access, COPILOT_TOKEN);
  assert.equal(f.replacements.length, 1);
});

for (const action of ["cancel", "logout", "unload"] as const) {
  test(`${action} aborts an in-flight HTTP OAuth attempt without committing a token`, async (t) => {
    const polling = deferred<void>();
    let providerSignal: AbortSignal | null | undefined;
    network(t, (url, init) => {
      if (url.endsWith("/login/device/code")) return json({ device_code: "fixture-device", user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device", interval: 0, expires_in: 60 });
      assert.ok(url.endsWith("/login/oauth/access_token")); providerSignal = init?.signal; polling.resolve();
      return waitForAbort(providerSignal);
    });
    const f = await fixture(t);
    const begin = await f.send({ action: "begin", method: "oauth" });
    const id = begin.body.attempt!.id;
    await polling.promise;
    if (action === "cancel") {
      const stale = await f.send({ action: "cancel", attemptId: "different-attempt" });
      assert.equal(stale.code, 409); assert.equal(stale.body.error, "stale-attempt"); assert.equal(providerSignal?.aborted, false);
      const replies = await Promise.all([f.send({ action, attemptId: id }), f.send({ action, attemptId: id })]);
      assert.deepEqual(replies.map(({ code }) => code).sort(), [200, 409]);
      assert.equal(replies.find(({ code }) => code === 200)?.body.attempt?.status, "cancelled");
      assert.equal(replies.find(({ code }) => code === 409)?.body.error, "already-running");
      assert.equal((await f.send({ action, attemptId: id })).body.attempt?.status, "cancelled", "a sequential repeated cancellation stays idempotent");
    } else if (action === "logout") {
      const reply = await f.send({ action }); assert.equal(reply.code, 200); assert.equal(reply.body.attempt, null);
    } else {
      await f.fiber.dispose();
      assert.equal(f.routes.size, 0); assert.equal(f.directory(), undefined); assert.equal(f.adapter(), undefined);
      assert.equal(f.ctx.authorization.describe(HARNESS_CREDENTIAL_KEY), undefined);
      assert.equal((await f.send()).code, 503);
      assert.equal(f.replacements.length, 0, "unloading must not emit a late model-directory update");
    }
    assert.equal(providerSignal?.aborted, true);
    assert.equal(f.records.has(HARNESS_CREDENTIAL_KEY), false); assert.equal(f.commits.length, 0);
  });
}

test("unload cancels Settings authorization waiting for a shared catalog reload without hanging cleanup", { timeout: 1500 }, async (t) => {
  const entered = deferred<void>();
  const emergencyRelease = deferred<Response>();
  t.signal.addEventListener("abort", () => emergencyRelease.resolve(json(catalog())), { once: true });
  let providerSignal: AbortSignal | null | undefined;
  network(t, (url, init) => {
    assert.equal(url, `${BASE}/models`);
    providerSignal = init?.signal;
    entered.resolve();
    return Promise.race([waitForAbort(providerSignal), emergencyRelease.promise]);
  });
  const f = await fixture(t);
  assert.equal((await f.send({ action: "begin", method: "api-key", apiKey: API_KEY })).code, 200);
  await entered.promise;
  assert.equal(f.records.has(HARNESS_CREDENTIAL_KEY), true, "the key was committed before model discovery started");
  await f.fiber.dispose();
  assert.equal(providerSignal?.aborted, true);
  assert.equal(f.routes.size, 0); assert.equal(f.directory(), undefined); assert.equal(f.adapter(), undefined);
  assert.equal(f.replacements.length, 0, "a disposed Settings owner must not refresh the Models surface");
  assert.deepEqual(f.records.get(HARNESS_CREDENTIAL_KEY), { kind: "api-key", key: API_KEY }, "unloading does not revoke a successful saved login");
});

test("concurrent HTTP catalog refreshes share one provider request and preserve directory metadata", async (t) => {
  const f = await fixture(t);
  f.records.set(HARNESS_CREDENTIAL_KEY, { kind: "api-key", key: API_KEY });
  const entered = deferred<void>(); const response = deferred<Response>();
  const calls = network(t, () => { entered.resolve(); return response.promise; });
  const refreshes = [f.send({ action: "refresh" }), f.send({ action: "refresh" })];
  await entered.promise; response.resolve(json(catalog()));
  for (const reply of await Promise.all(refreshes)) assert.equal(reply.code, 200);
  assert.equal(calls.length, 1); assert.equal(f.replacements.length, 2);
  assert.deepEqual(f.replacements[0], f.replacements[1]);
  assert.equal(f.directory()?.[0]?.settingsNs, NS); assert.deepEqual(f.directory()?.[0]?.settingsPath, []);
});

test("malformed and unsupported HTTP requests are rejected without network or credential writes", async (t) => {
  const f = await fixture(t);
  const cases: Array<[unknown, number, string]> = [
    [null, 400, "invalid-request"], [[], 400, "invalid-request"], [42, 400, "invalid-request"],
    [{}, 400, "invalid-action"], [{ action: "unknown" }, 400, "invalid-action"],
    [{ action: "begin", method: "unknown" }, 400, "invalid-method"],
    [{ action: "begin", method: "api-key" }, 400, "invalid-input"],
    [{ action: "begin", method: "api-key", apiKey: "  " }, 400, "invalid-input"],
    [{ action: "begin", method: "api-key", apiKey: false }, 400, "invalid-input"],
    [{ action: "begin", method: "api-key", apiKey: "x".repeat(65537) }, 400, "invalid-input"],
    [{ action: "begin", method: "oauth", enterpriseDomain: 123 }, 400, "invalid-input"],
    [{ action: "cancel" }, 409, "stale-attempt"],
  ];
  for (const [body, code, error] of cases) {
    const reply = await f.send(body); assert.equal(reply.code, code); assert.equal(reply.body.error, error);
  }
  assert.equal((await f.send({}, { contentType: "text/plain" })).code, 415);
  assert.equal((await f.send(undefined, { text: "{ malformed" })).code, 400);
  assert.equal(f.commits.length, 0); assert.equal(f.records.size, 0);
});

test("authorization errors are reduced to stable browser error codes, not token-bearing provider responses", async (t) => {
  network(t, () => new Response(`denied ${GITHUB_TOKEN} ${COPILOT_TOKEN}`, { status: 403 }));
  const f = await fixture(t);
  assert.equal((await f.send({ action: "begin", method: "oauth" })).code, 200);
  const result = await f.settled();
  assert.equal(result.body.attempt?.status, "error"); assert.equal(result.body.attempt?.error, "authorization-failed");
  assert.equal(result.body.configured, false); assert.equal(f.commits.length, 0);
});

test("a catalog outage preserves successful API-key authorization while refresh reports a stable 502", async (t) => {
  network(t, () => new Response(`private model body ${API_KEY}`, { status: 503 }));
  const f = await fixture(t);
  assert.equal((await f.send({ action: "begin", method: "api-key", apiKey: API_KEY })).code, 200);
  const result = await f.settled();
  assert.equal(result.body.attempt?.status, "authorized"); assert.equal(result.body.attempt?.error, "models-unavailable");
  assert.equal(result.body.configured, true); assert.equal(result.body.authType, "api_key");
  const refresh = await f.send({ action: "refresh" });
  assert.equal(refresh.code, 502); assert.equal(refresh.body.error, "models-unavailable");
  assert.deepEqual(f.records.get(HARNESS_CREDENTIAL_KEY), { kind: "api-key", key: API_KEY });
});

test("logout succeeds with an explicit warning when fallback API-key model discovery is unavailable", async (t) => {
  const f = await fixture(t);
  f.records.set(HARNESS_CREDENTIAL_KEY, { kind: "api-key", key: API_KEY });
  f.references.set("POWER_COPILOT_API_KEY", COPILOT_TOKEN);
  const calls = network(t, (url, init) => {
    assert.equal(url, `${BASE}/models`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${COPILOT_TOKEN}`);
    return new Response(`private provider body ${API_KEY} ${COPILOT_TOKEN}`, { status: 503 });
  });
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await f.send({ action: "logout" });
    assert.equal(result.code, 200);
    assert.equal(result.body.warning, "models-unavailable");
    assert.equal(result.body.configured, true);
    assert.equal(result.body.credentialSource, "reference");
    assert.equal(result.body.authType, "api_key");
    assert.equal(result.body.attempt, null);
    assert.equal(f.records.has(HARNESS_CREDENTIAL_KEY), false);
  }
  assert.equal(calls.length, 2);
  assert.equal(f.replacements.length, 2, "saved-login removal still notifies the Models directory even during an outage");
});

test("logout fences another tab's sign-in through record deletion and subsequent model reload", async (t) => {
  const f = await fixture(t);
  f.records.set(HARNESS_CREDENTIAL_KEY, { kind: "api-key", key: API_KEY });
  f.references.set("POWER_COPILOT_API_KEY", GITHUB_TOKEN);
  const deleting = deferred<void>(); const releaseDelete = deferred<void>();
  const reloading = deferred<void>(); const releaseReload = deferred<Response>();
  const deleteRecord = f.ctx.credentials.deleteRecord.bind(f.ctx.credentials);
  t.mock.method(f.ctx.credentials, "deleteRecord", async (key: CredentialKey) => {
    deleting.resolve(); await releaseDelete.promise; await deleteRecord(key);
  });
  let holdModels = true;
  network(t, (url) => {
    assert.equal(url, `${BASE}/models`);
    if (holdModels) { reloading.resolve(); return releaseReload.promise; }
    return json(catalog());
  });
  const logout = f.send({ action: "logout" });
  try {
    await deleting.promise;
    for (const request of [
      { action: "begin", method: "api-key", apiKey: COPILOT_TOKEN },
      { action: "cancel", attemptId: "another-tab" },
      { action: "logout" },
    ]) {
      const rejected = await f.send(request);
      assert.equal(rejected.code, 409); assert.equal(rejected.body.error, "already-running");
    }
    assert.equal(f.commits.length, 0, "the concurrent sign-in never reaches the credential commit");
    assert.deepEqual(f.records.get(HARNESS_CREDENTIAL_KEY), { kind: "api-key", key: API_KEY });
    releaseDelete.resolve();
    await reloading.promise;
    const duringReload = await f.send({ action: "begin", method: "api-key", apiKey: COPILOT_TOKEN });
    assert.equal(duringReload.code, 409); assert.equal(duringReload.body.error, "already-running");
    assert.equal(f.commits.length, 0, "the write fence remains held after deletion until reload finishes");
    holdModels = false; releaseReload.resolve(json(catalog()));
    assert.equal((await logout).code, 200);
    assert.equal(f.records.has(HARNESS_CREDENTIAL_KEY), false);
    assert.equal((await f.send({ action: "begin", method: "api-key", apiKey: COPILOT_TOKEN })).code, 200);
    assert.equal((await f.settled()).body.attempt?.status, "authorized");
    assert.equal(f.commits.length, 1, "the write fence is released after logout completes");
    assert.deepEqual(f.records.get(HARNESS_CREDENTIAL_KEY), { kind: "api-key", key: COPILOT_TOKEN });
  } finally {
    releaseDelete.resolve(); releaseReload.resolve(json(catalog()));
    await logout;
  }
});

test("successful model refresh clears a prior terminal models-unavailable error without another login", async (t) => {
  let available = false;
  network(t, (url) => {
    assert.equal(url, `${BASE}/models`);
    return available ? json(catalog("recovered-model")) : new Response(`private provider body ${API_KEY}`, { status: 503 });
  });
  const f = await fixture(t);
  assert.equal((await f.send({ action: "begin", method: "api-key", apiKey: API_KEY })).code, 200);
  const failed = await f.settled();
  assert.equal(failed.body.attempt?.status, "authorized");
  assert.equal(failed.body.attempt?.error, "models-unavailable");
  const id = failed.body.attempt!.id;
  assert.equal((await f.send({ action: "refresh" })).code, 502);
  assert.equal((await f.send()).body.attempt?.error, "models-unavailable", "failed refreshes retain the actionable error");
  available = true;
  const recovered = await f.send({ action: "refresh" });
  assert.equal(recovered.code, 200); assert.equal(recovered.body.attempt?.id, id);
  assert.equal(recovered.body.attempt?.status, "authorized");
  assert.equal(recovered.body.attempt?.error, undefined);
  assert.equal((await f.send()).body.attempt?.error, undefined, "subsequent status polls do not resurrect the stale error");
  assert.equal(recovered.body.configured, true); assert.equal(recovered.body.credentialSource, "saved");
  assert.equal(f.commits.length, 1, "catalog recovery does not reauthorize or overwrite the saved credential");
  assert.deepEqual((await f.adapter()!.listModels("power-copilot")).map(({ id }) => id), ["recovered-model"]);
});

test("GET resolves configured API-key references without returning or persisting the resolved value", async (t) => {
  const f = await fixture(t);
  f.references.set("POWER_COPILOT_API_KEY", API_KEY);
  const configured = await f.send(); assert.equal(configured.body.configured, true); assert.equal(configured.body.authType, "api_key");
  assert.equal(configured.body.credentialSource, "reference");
  assert.equal(f.records.size, 0);
  f.references.delete("POWER_COPILOT_API_KEY");
  assert.equal((await f.send()).body.configured, false);
});
