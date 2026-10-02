import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

function createInteraction(answer: string) {
  const prompts: Array<{ type: string; message: string }> = [];
  const notifications: Array<{ type: string }> = [];
  const interaction: ProviderAuthInteraction = {
    signal: new AbortController().signal,
    notify(event) {
      notifications.push(event);
    },
    async prompt(prompt) {
      prompts.push(prompt);
      return answer;
    },
  };
  return { interaction, prompts, notifications };
}

function registeredProvider(): Provider {
  let provider: Provider | undefined;
  extension({
    registerProvider(registered: Provider) {
      provider = registered;
    },
  } as ExtensionAPI);
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

test("API-key login uses Pi's standard secret prompt and stores an API-key credential", async () => {
  const { interaction, prompts } = createInteraction("pasted-api-key");
  const apiKeyAuth = envApiKeyAuth("Power Copilot API key", []);
  const credential = await apiKeyAuth.login?.(interaction);

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.type, "secret");
  assert.deepEqual(credential, { type: "api_key", key: "pasted-api-key" });
});
