import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import {
  createModels,
  InMemoryCredentialStore,
  type ApiKeyCredential,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

function createInteraction(answer: string, source = "api-key") {
  const prompts: Array<{ type: string; message: string }> = [];
  const notifications: Array<{ type: string }> = [];
  const interaction: ProviderAuthInteraction = {
    signal: new AbortController().signal,
    notify(event) {
      notifications.push(event);
    },
    async prompt(prompt) {
      prompts.push(prompt);
      return prompt.type === "select" ? source : answer;
    },
  };
  return { interaction, prompts, notifications };
}

function registeredProvider(): Provider {
  let provider: Provider | undefined;
  extension({
    on() { return () => {}; },
    registerProvider(registered: Provider) {
      provider = registered;
    },
  } as unknown as ExtensionAPI);
  assert.ok(provider);
  return provider;
}

test("registered OAuth login completes device authorization when Pi supplies login options", async (t) => {
  const { interaction, prompts, notifications } = createInteraction("");
  const provider = registeredProvider();
  assert.ok(provider.auth.oauth);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    let body: unknown;
    switch (url) {
      case "https://github.com/login/device/code":
        body = {
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 0,
          expires_in: 60,
        };
        break;
      case "https://github.com/login/oauth/access_token":
        body = { access_token: "github-oauth-token" };
        break;
      case "https://api.github.com/copilot_internal/v2/token":
        body = { token: "copilot-access", expires_at: 2_000_000_000 };
        break;
      case "https://api.githubcopilot.com/models":
        body = { data: [] };
        break;
      default:
        throw new Error(`Unexpected request: ${url}`);
    }
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });

  // Pi 0.99 passes LoginOptions; the minimum supported SDK only types the first argument.
  const credentials = await Reflect.apply(provider.auth.oauth.login, provider.auth.oauth, [
    interaction,
    { getDeviceId: () => "pi-installation-id" },
  ]);

  assert.deepEqual(prompts.map(({ type }) => type), ["text"]);
  assert.deepEqual(notifications, [
    {
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 0,
      expiresInSeconds: 60,
    },
  ]);
  assert.equal(credentials.type, "oauth");
  assert.equal(credentials.authMethod, "github-oauth");
  assert.equal(credentials.refresh, "github-oauth-token");
  assert.equal(credentials.access, "copilot-access");
  assert.equal(credentials.expires, 2_000_000_000_000 - 5 * 60 * 1000);
});

test("Pi automatically renews expired OAuth credentials without depending on model discovery", async (t) => {
  const provider = registeredProvider();
  const credentials = new InMemoryCredentialStore();
  const original: OAuthCredential = {
    type: "oauth",
    authMethod: "github-oauth",
    refresh: "github-oauth-token",
    access: "expired-copilot-token",
    expires: 1,
    availableModelIds: ["previous-model"],
  };
  await credentials.modify(provider.id, async () => original);
  const models = createModels({ credentials });
  models.setProvider(provider);

  const calls: string[] = [];
  let exchanges = 0;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/models")) return new Response(null, { status: 503 });
    assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-oauth-token");
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ token: `renewed-${++exchanges}`, expires_at: expiresAt }));
  });

  // Concurrent requests use Pi's credential lock and persist a single renewal.
  const resolved = await Promise.all([models.getAuth(provider.id), models.getAuth(provider.id)]);
  for (const auth of resolved) {
    assert.equal(auth?.auth.apiKey, "renewed-1");
    assert.equal(auth?.auth.baseUrl, "https://api.githubcopilot.com");
  }
  const saved = await credentials.read(provider.id);
  assert.deepEqual(saved, {
    ...original,
    access: "renewed-1",
    expires: expiresAt * 1000 - 5 * 60 * 1000,
  });

  // A new runtime reuses the stored renewal; the next expiry reuses the GitHub token.
  const nextSession = createModels({ credentials });
  nextSession.setProvider(registeredProvider());
  assert.equal((await nextSession.getAuth(provider.id))?.auth.apiKey, "renewed-1");
  assert.equal(exchanges, 1);
  assert.ok(saved?.type === "oauth");
  await credentials.modify(provider.id, async () => ({ ...saved, expires: 1 }));
  assert.equal((await nextSession.getAuth(provider.id))?.auth.apiKey, "renewed-2");
  assert.equal((await credentials.read(provider.id))?.type, "oauth");
  assert.deepEqual(calls, Array(2).fill("https://api.github.com/copilot_internal/v2/token"));
});

test("failed automatic renewal preserves the GitHub credential for a later retry", async (t) => {
  const provider = registeredProvider();
  const credentials = new InMemoryCredentialStore();
  const original: OAuthCredential = {
    type: "oauth", authMethod: "github-oauth", refresh: "github-token", access: "expired", expires: 1,
  };
  await credentials.modify(provider.id, async () => original);
  const models = createModels({ credentials });
  models.setProvider(provider);
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.github.com/copilot_internal/v2/token");
    if (++attempts === 1) return new Response(null, { status: 503 });
    return new Response(JSON.stringify({ token: "renewed", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  });

  await assert.rejects(models.getAuth(provider.id), /OAuth refresh failed.*HTTP 503/);
  assert.deepEqual(await credentials.read(provider.id), original);
  assert.equal((await models.getAuth(provider.id))?.auth.apiKey, "renewed");
  assert.equal(attempts, 2);
});

test("registered OAuth renewal honors cancellation before making a request", async (t) => {
  const provider = registeredProvider();
  assert.ok(provider.auth.oauth);
  const controller = new AbortController();
  const reason = new Error("Refresh cancelled");
  controller.abort(reason);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Cancelled refresh must not make a network request");
  });

  await assert.rejects(
    provider.auth.oauth.refresh(
      { type: "oauth", refresh: "github-token", access: "expired", expires: 1 },
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Pi CLI login stores only API-key source metadata and resolves the raw token afresh", async (t) => {
  const provider = registeredProvider();
  const { interaction, prompts, notifications } = createInteraction("", "github-cli");
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(provider);
  let cliCalls = 0;
  t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    assert.equal(args[0], "gh");
    assert.deepEqual(args[1], ["auth", "token", "--hostname", "github.com"]);
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, `private-github-token-${++cliCalls}\n`, "");
    return { stdin: { end() {} } } as ChildProcess;
  }) as typeof childProcess.execFile);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("CLI auth must not call device authorization, token exchange, or discovery");
  });
  const loggedIn = await models.login(provider.id, "api_key", interaction, { getDeviceId: () => "pi-id" });
  assert.deepEqual(prompts.map(({ type }) => type), ["select", "text"]);
  assert.deepEqual(notifications.map(({ type }) => type), ["progress"]);
  assert.deepEqual(loggedIn, { type: "api_key", env: {
    POWER_COPILOT_AUTH_SOURCE: "github-cli", POWER_COPILOT_GITHUB_HOST: "github.com",
  } });
  assert.equal(cliCalls, 1);
  assert.deepEqual(await models.checkAuth(provider.id), { type: "api_key", source: "GitHub CLI" });
  assert.equal(cliCalls, 1, "availability checks must not spawn gh");
  assert.deepEqual((await models.getAuth(provider.id))?.auth, {
    apiKey: "private-github-token-2", baseUrl: "https://api.githubcopilot.com",
  });
  assert.equal((await models.getAuth(provider.id))?.auth.apiKey, "private-github-token-3");
  assert.deepEqual(await credentials.read(provider.id), loggedIn);
  assert.doesNotMatch(JSON.stringify(await credentials.read(provider.id)), /private-github-token/);
  const nextSession = createModels({ credentials });
  nextSession.setProvider(registeredProvider());
  assert.equal((await nextSession.getAuth(provider.id))?.auth.apiKey, "private-github-token-4");
  assert.equal((await nextSession.getAuth(provider.id, { apiKey: "runtime-override" }))?.auth.apiKey, "runtime-override");
  assert.equal(cliCalls, 4, "explicit keys must bypass CLI resolution");
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const [source, hostname, baseUrl] of [
  ["api-key", "github.com", "https://api.githubcopilot.com"],
  ["github-cli", "github.com", "https://api.githubcopilot.com"],
  ["github-cli", "company.ghe.com", "https://api.enterprise.githubcopilot.com"],
] as const) {
  test(`${source} ${hostname} discovery sends the raw gh token directly to Copilot`, async (t) => {
    const provider = registeredProvider();
    const credentials = new InMemoryCredentialStore();
    const token = "same-raw-gh-token";
    await credentials.modify(provider.id, async () => source === "api-key"
      ? { type: "api_key", key: token }
      : { type: "api_key", env: { POWER_COPILOT_AUTH_SOURCE: "github-cli", POWER_COPILOT_GITHUB_HOST: hostname } });
    const models = createModels({ credentials });
    models.setProvider(provider);
    t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
      assert.equal(source, "github-cli");
      (args[3] as (error: null, stdout: string, stderr: string) => void)(null, token, "");
      return { stdin: { end() {} } } as ChildProcess;
    }) as typeof childProcess.execFile);
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      assert.equal(String(input), `${baseUrl}/models`, "never call the token-exchange endpoint");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      return new Response(JSON.stringify({ data: [{ id: "one", name: "One", capabilities: {
        type: "chat", limits: { max_context_window_tokens: 10000, max_output_tokens: 1000 },
      }, supported_endpoints: ["/responses"] }] }));
    });
    assert.equal((await models.refresh()).errors.size, 0);
    assert.equal(models.getModels(provider.id)[0]?.id, "one");
    assert.deepEqual(requests, [`${baseUrl}/models`]);
    assert.equal(models.getModels(provider.id)[0]?.baseUrl, baseUrl);
  });
}

test("failed CLI resolution preserves its source config and retries gh on the next request", async (t) => {
  const provider = registeredProvider();
  const original: ApiKeyCredential = {
    type: "api_key", env: { POWER_COPILOT_AUTH_SOURCE: "github-cli", POWER_COPILOT_GITHUB_HOST: "github.com" },
  };
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider.id, async () => original);
  const models = createModels({ credentials });
  models.setProvider(provider);
  let cliCalls = 0;
  t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    if (++cliCalls === 1) callback(new Error("private-stderr-token"), "", "private-stderr-token");
    else callback(null, "fresh-github-token", "");
    return { stdin: { end() {} } } as ChildProcess;
  }) as typeof childProcess.execFile);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("CLI resolution must not call token exchange");
  });
  await assert.rejects(models.getAuth(provider.id), (error: Error) => {
    assert.match(error.message, /GitHub CLI could not read a token/);
    assert.doesNotMatch(error.message, /private-stderr-token/);
    return true;
  });
  assert.deepEqual(await credentials.read(provider.id), original);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal((await models.getAuth(provider.id))?.auth.apiKey, "fresh-github-token");
  assert.equal(cliCalls, 2);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const expired of [false, true]) {
  test(`legacy CLI OAuth records use raw gh tokens even when ${expired ? "expired" : "still valid"}`, async (t) => {
    const provider = registeredProvider();
    const credentials = new InMemoryCredentialStore();
    const original: OAuthCredential = {
      type: "oauth", authMethod: "github-cli", refresh: "github-cli", access: "old-exchanged-token",
      expires: expired ? 1 : Date.now() + 3600000, availableModelIds: ["previous-model"],
    };
    await credentials.modify(provider.id, async () => original);
    const models = createModels({ credentials });
    models.setProvider(provider);
    t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
      (args[3] as (error: null, stdout: string, stderr: string) => void)(null, "raw-legacy-gh-token", "");
      return { stdin: { end() {} } } as ChildProcess;
    }) as typeof childProcess.execFile);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("No legacy exchange allowed"); });
    assert.equal((await models.getAuth(provider.id))?.auth.apiKey, "raw-legacy-gh-token");
    const saved = await credentials.read(provider.id);
    assert.ok(saved?.type === "oauth");
    assert.deepEqual(saved.availableModelIds, ["previous-model"]);
    assert.equal(saved.access, expired ? "" : original.access);
    assert.doesNotMatch(JSON.stringify(saved), /raw-legacy-gh-token/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("unknown Pi login sources fail instead of silently launching device authorization", async (t) => {
  const provider = registeredProvider();
  assert.ok(provider.auth.apiKey?.login);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
  await assert.rejects(provider.auth.apiKey.login(createInteraction("", "unknown").interaction), /Unknown API key source/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("API-key login uses Pi's standard secret prompt and stores an API-key credential", async () => {
  const { interaction, prompts } = createInteraction("pasted-api-key");
  const provider = registeredProvider();
  const credential = await provider.auth.apiKey?.login?.(interaction);

  assert.deepEqual(prompts.map(({ type }) => type), ["select", "secret"]);
  assert.deepEqual(credential, { type: "api_key", key: "pasted-api-key" });
});
