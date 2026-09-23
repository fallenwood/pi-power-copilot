import assert from "node:assert/strict";
import test from "node:test";
import { envApiKeyAuth, type OAuthCredentials, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { loginPowerCopilot } from "../src/auth.ts";

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

test("GitHub OAuth uses Pi's standard OAuth interaction without another login-mode menu", async () => {
  const { interaction, prompts, notifications } = createInteraction("");
  let receivedCallbacks: OAuthLoginCallbacks | undefined;

  const credentials = await loginPowerCopilot(interaction, async (callbacks) => {
    receivedCallbacks = callbacks;
    callbacks.onDeviceCode({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
    });
    return {
      refresh: "github-refresh",
      access: "copilot-access",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;
  });

  assert.equal(prompts.length, 0);
  assert.ok(receivedCallbacks);
  assert.deepEqual(notifications, [
    {
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
    },
  ]);
  assert.equal(credentials.type, "oauth");
  assert.equal(credentials.authMethod, "github-oauth");
  assert.equal(credentials.access, "copilot-access");
});

test("API-key login uses Pi's standard secret prompt and stores an API-key credential", async () => {
  const { interaction, prompts } = createInteraction("pasted-api-key");
  const apiKeyAuth = envApiKeyAuth("Power Copilot API key", []);
  const credential = await apiKeyAuth.login?.(interaction);

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.type, "secret");
  assert.equal(prompts[0]?.message, "Enter Power Copilot API key");
  assert.deepEqual(credential, { type: "api_key", key: "pasted-api-key" });
});
