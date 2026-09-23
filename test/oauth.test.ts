import assert from "node:assert/strict";
import test from "node:test";
import {
  loginPowerCopilot,
  refreshPowerCopilotToken,
  resolvePowerCopilotBaseUrl,
} from "../src/oauth.ts";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const modelCatalog = {
  data: [
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3-Codex",
      model_picker_enabled: true,
      capabilities: {
        type: "chat",
        limits: { max_context_window_tokens: 400000, max_output_tokens: 128000 },
        supports: { tool_calls: true },
      },
      supported_endpoints: ["/responses"],
    },
  ],
};

test("performs a device-code login and stores a separate Copilot credential", async () => {
  const calls: string[] = [];
  let deviceCode = "";
  const credentials = await loginPowerCopilot(
    {
      onAuth() {},
      onDeviceCode(info) {
        deviceCode = info.userCode;
      },
      async onPrompt() {
        return "";
      },
      async onSelect() {
        return undefined;
      },
    },
    async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/login/device/code")) {
        return response({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          interval: 0,
          expires_in: 60,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        assert.match(String(init?.body), /device_code=device-code/);
        return response({ access_token: "github-oauth-token" });
      }
      if (url.endsWith("/copilot_internal/v2/token")) {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer github-oauth-token");
        return response({
          token: "copilot-token;proxy-ep=proxy.individual.githubcopilot.com",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      if (url === "https://api.githubcopilot.com/models") return response(modelCatalog);
      throw new Error(`Unexpected request: ${url}`);
    },
  );

  assert.equal(deviceCode, "ABCD-EFGH");
  assert.deepEqual(calls, [
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
    "https://api.github.com/copilot_internal/v2/token",
    "https://api.githubcopilot.com/models",
  ]);
  assert.equal(credentials.refresh, "github-oauth-token");
  assert.equal(credentials.access, "copilot-token;proxy-ep=proxy.individual.githubcopilot.com");
  assert.deepEqual(credentials.availableModelIds, ["gpt-5.3-codex"]);
});

test("refreshes Copilot tokens and refreshes the model availability snapshot", async () => {
  const calls: string[] = [];
  const credentials = await refreshPowerCopilotToken(
    {
      refresh: "enterprise-github-token",
      access: "expired-copilot-token",
      expires: 1,
      enterpriseUrl: "enterprise.example.com",
    },
    new AbortController().signal,
    async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://api.enterprise.example.com/copilot_internal/v2/token") {
        return response({
          token: "new-copilot-token;proxy-ep=proxy.enterprise-copilot.example",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      if (url === "https://api.enterprise.githubcopilot.com/models") return response(modelCatalog);
      throw new Error(`Unexpected request: ${url}`);
    },
  );

  assert.deepEqual(calls, [
    "https://api.enterprise.example.com/copilot_internal/v2/token",
    "https://api.enterprise.githubcopilot.com/models",
  ]);
  assert.equal(credentials.refresh, "enterprise-github-token");
  assert.equal(credentials.access, "new-copilot-token;proxy-ep=proxy.enterprise-copilot.example");
  assert.deepEqual(credentials.availableModelIds, ["gpt-5.3-codex"]);
});

test("resolves the API host from the login enterprise URL or proxy endpoint", () => {
  assert.equal(
    resolvePowerCopilotBaseUrl("token;proxy-ep=proxy.individual.githubcopilot.com"),
    "https://api.githubcopilot.com",
  );
  assert.equal(
    resolvePowerCopilotBaseUrl("token", "enterprise.example.com"),
    "https://api.enterprise.githubcopilot.com",
  );
});

test("explains a forbidden Copilot token exchange without exposing token-like text", async () => {
  await assert.rejects(
    () =>
      refreshPowerCopilotToken(
        { refresh: "github-token", access: "", expires: 0 },
        new AbortController().signal,
        async () => response({ message: "Token gho_sensitive was denied" }, 403),
      ),
    (error: Error) => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /not be eligible for Copilot/);
      assert.doesNotMatch(error.message, /gho_sensitive/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});
