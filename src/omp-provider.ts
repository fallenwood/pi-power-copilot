import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import type { ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { fetchModelCatalog, type PowerCopilotApi, type PowerCopilotModelConfig } from "./catalog.ts";
import { applyContextWindows, readContextWindows } from "./context-window.ts";
import { loginPowerCopilot, refreshPowerCopilotToken, resolvePowerCopilotBaseUrl } from "./oauth.ts";

// OMP discovery peeks at stored access directly, bypassing oauth.getApiKey.
// Keep routing alongside the token in an opaque access value; requests unwrap it.
const ACCESS_PREFIX = "power-copilot-oauth-v1:";
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const OMP_APIS: Readonly<Record<PowerCopilotApi, string>> = {
  "openai-responses": "power-copilot-openai-responses",
  "anthropic-messages": "power-copilot-anthropic-messages",
  "openai-completions": "power-copilot-openai-completions",
};

function packCredential(credential: OAuthCredentials): OAuthCredentials {
  return { ...credential, access: ACCESS_PREFIX + JSON.stringify({
    token: credential.access,
    ...(credential.enterpriseUrl ? { enterpriseUrl: credential.enterpriseUrl } : {}),
  }) };
}

function resolveAccess(access: string): { token: string; baseUrl: string } {
  if (!access.startsWith(ACCESS_PREFIX)) {
    return { token: access, baseUrl: resolvePowerCopilotBaseUrl(access) };
  }
  let value: unknown;
  try {
    value = JSON.parse(access.slice(ACCESS_PREFIX.length));
  } catch {
    throw new Error("Invalid Power Copilot OMP credential; sign in again");
  }
  if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" ||
      ("enterpriseUrl" in value && typeof value.enterpriseUrl !== "string")) {
    throw new Error("Invalid Power Copilot OMP credential; sign in again");
  }
  const enterpriseUrl = "enterpriseUrl" in value && typeof value.enterpriseUrl === "string" ? value.enterpriseUrl : undefined;
  return { token: value.token, baseUrl: resolvePowerCopilotBaseUrl(value.token, enterpriseUrl) };
}

function nativeModel(model: PowerCopilotModelConfig, baseUrl: string): ProviderModelConfig & { baseUrl: string } {
  const { thinkingLevelMap, headers: _headers, ...metadata } = model;
  const efforts = EFFORTS.filter((effort) => typeof thinkingLevelMap?.[effort] === "string");
  return {
    ...metadata,
    api: OMP_APIS[model.api],
    baseUrl,
    ...(efforts.length ? { thinking: {
      mode: model.api === "anthropic-messages" ? "anthropic-adaptive" as const : "effort" as const,
      // OMP's Effort is a string enum; catalog values use its exact wire spellings.
      efforts: efforts as NonNullable<ProviderModelConfig["thinking"]>["efforts"],
    } } : {}),
  };
}

/** Native OMP registration; no Pi provider objects or streaming implementations cross this boundary. */
export function createOmpPowerCopilotProvider(configPath: string): ProviderConfig {
  const contextWindows = readContextWindows(configPath);
  return {
    oauth: {
      name: "Power Copilot",
      async login(callbacks: OAuthLoginCallbacks) {
        callbacks.signal?.throwIfAborted();
        const method = (await callbacks.onPrompt({
          message: "Authentication method: oauth or api-key (leave blank for oauth)",
          placeholder: "oauth", allowEmpty: true,
        })).trim();
        callbacks.signal?.throwIfAborted();
        if (method === "api-key") {
          const token = (await callbacks.onPrompt({ message: "Power Copilot API key", secret: true })).trim();
          callbacks.signal?.throwIfAborted();
          if (!token) throw new Error("A Power Copilot API key is required");
          return token;
        }
        if (method && method !== "oauth") throw new Error("Unknown Power Copilot authentication method");
        return packCredential(await loginPowerCopilot({
          onAuth: callbacks.onAuth,
          onPrompt: callbacks.onPrompt,
          onProgress: callbacks.onProgress,
          onSelect: ({ message, options }) => callbacks.onPrompt({
            message: `${message} (${options.map((option) => option.id).join(", ")})`,
          }),
          onDeviceCode: (device) => callbacks.onAuth({
            url: device.verificationUri,
            instructions: `Enter code: ${device.userCode}`,
          }),
          signal: callbacks.signal,
        }));
      },
      async refreshToken(credential: OAuthCredentials, signal?: AbortSignal) {
        const refreshed = await refreshPowerCopilotToken({
          ...credential, access: resolveAccess(credential.access).token,
        }, signal ?? AbortSignal.timeout(30_000));
        return packCredential(refreshed);
      },
      getApiKey: (credential) => resolveAccess(credential.access).token,
    },
    async fetchDynamicModels(access) {
      if (!access) throw new Error("Sign in to Power Copilot with /login before refreshing models");
      const { token, baseUrl } = resolveAccess(access);
      const models = await fetchModelCatalog(baseUrl, token, AbortSignal.timeout(30_000));
      return applyContextWindows(models, contextWindows, configPath, "restart OMP and refresh models")
        .map((model) => nativeModel(model, baseUrl));
    },
  };
}
