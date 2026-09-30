import assert from "node:assert/strict";
import test from "node:test";
import { envApiKeyAuth, type Provider, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
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

test("registered OAuth login completes device authorization when Pi supplies login options", async (t) => {
  const { interaction, prompts, notifications } = createInteraction("");
  let provider: Provider | undefined;
  extension({
    registerProvider(registered: Provider) {
      provider = registered;
    },
  } as ExtensionAPI);
  assert.ok(provider?.auth.oauth);

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

test("API-key login uses Pi's standard secret prompt and stores an API-key credential", async () => {
  const { interaction, prompts } = createInteraction("pasted-api-key");
  const apiKeyAuth = envApiKeyAuth("Power Copilot API key", []);
  const credential = await apiKeyAuth.login?.(interaction);

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.type, "secret");
  assert.deepEqual(credential, { type: "api_key", key: "pasted-api-key" });
});
