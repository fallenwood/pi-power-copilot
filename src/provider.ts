import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { withCopilotBearerAuth } from "./anthropic-auth.ts";
import { loginPowerCopilot, loginPowerCopilotApiKeyWithSourceSelection, refreshPowerCopilotCredential } from "./auth.ts";
import { isGitHubCliCredential, resolveGitHubCliAuth, resolveLegacyGitHubCliAuth } from "./github-cli.ts";
import { fetchModelCatalog, type PowerCopilotApi, type PowerCopilotModelConfig } from "./catalog.ts";
import { COPILOT_REQUEST_HEADERS } from "./copilot-headers.ts";
import { applyContextWindows, ContextWindowError, readContextWindows } from "./context-window.ts";
import { normalizeGitHubDomain, resolvePowerCopilotBaseUrl } from "./oauth.ts";

const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

export function createPowerCopilotProvider(
  configPath: string,
  contextWindows = readContextWindows(configPath),
  restartHint = "restart Pi",
  options: { githubCliLogin?: boolean } = {},
): Provider<PowerCopilotApi> {
  let configurationError: ContextWindowError | undefined;
  function configured<T extends Pick<PowerCopilotModelConfig, "id" | "contextWindow">>(models: readonly T[]): T[] {
    try {
      const result = applyContextWindows(models, contextWindows, configPath, restartHint);
      configurationError = undefined;
      return result;
    } catch (error) {
      if (error instanceof ContextWindowError) configurationError = error;
      throw error;
    }
  }
  function checkLoginConfiguration(): void {
    if (configurationError) throw configurationError;
  }
  const apiKeyAuth = envApiKeyAuth("Power Copilot API key", []);
  const apiKeyLogin = apiKeyAuth.login;
  const anthropic = anthropicMessagesApi();
  const provider = createProvider<PowerCopilotApi>({
    id: "power-copilot",
    name: "Power Copilot",
    baseUrl: DEFAULT_BASE_URL,
    headers: COPILOT_REQUEST_HEADERS,
    auth: {
      apiKey: {
        ...apiKeyAuth,
        login: apiKeyLogin && (async (interaction) => {
          checkLoginConfiguration();
          return options.githubCliLogin
            ? loginPowerCopilotApiKeyWithSourceSelection(interaction)
            : apiKeyLogin(interaction);
        }),
        ...(options.githubCliLogin ? {
          check: async (input: Parameters<typeof apiKeyAuth.resolve>[0]) => {
            input.signal.throwIfAborted();
            if (isGitHubCliCredential(input.credential)) return { type: "api_key" as const, source: "GitHub CLI" };
            const resolved = await apiKeyAuth.resolve(input);
            return resolved ? { type: "api_key" as const, source: resolved.source } : undefined;
          },
          resolve: async (input: Parameters<typeof apiKeyAuth.resolve>[0]) => {
            if (!isGitHubCliCredential(input.credential)) return apiKeyAuth.resolve(input);
            const resolved = await resolveGitHubCliAuth(input.credential!, input.signal);
            // Pi forwards resolved key + env (not AuthResult.baseUrl) to the discovery hook.
            return { ...resolved, env: input.credential!.env };
          },
        } : {}),
      },
      oauth: {
        name: "Power Copilot",
        isSubscription: true,
        login: async (interaction) => {
          checkLoginConfiguration();
          return loginPowerCopilot(interaction);
        },
        refresh: refreshPowerCopilotCredential,
        toAuth: async (credential) => credential.authMethod === "github-cli"
          ? (await resolveLegacyGitHubCliAuth(credential, AbortSignal.timeout(10_000))).auth
          : {
            apiKey: credential.access,
            baseUrl: resolvePowerCopilotBaseUrl(
              credential.access,
              typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : undefined,
            ),
          },
      },
    },
    models: [],
    fetchModels: async ({ credential, signal }) => {
      const cliAuth = options.githubCliLogin && credential?.type === "api_key" && isGitHubCliCredential(credential)
        ? await resolveGitHubCliAuth(credential, signal)
        : credential?.type === "oauth" && credential.authMethod === "github-cli"
          ? await resolveLegacyGitHubCliAuth(credential, signal)
          : undefined;
      const token = cliAuth?.auth.apiKey ?? (
        credential?.type === "oauth"
          ? credential.access
          : credential?.type === "api_key"
            ? credential.key
            : undefined);
      if (!token) throw new Error("Power Copilot authentication did not provide an access token");

      const enterpriseDomain =
        credential?.type === "oauth" && typeof credential.enterpriseUrl === "string"
          ? credential.enterpriseUrl
          : options.githubCliLogin && credential?.type === "api_key" &&
              credential.env?.POWER_COPILOT_AUTH_SOURCE === "github-cli"
            ? normalizeGitHubDomain(credential.env.POWER_COPILOT_GITHUB_HOST ?? "")
            : undefined;
      const modelBaseUrl = cliAuth?.auth.baseUrl ?? resolvePowerCopilotBaseUrl(
        token, enterpriseDomain === "github.com" ? undefined : enterpriseDomain,
      );
      const models = await fetchModelCatalog(modelBaseUrl, token, signal);
      configured(models);
      return models.map(
        (model): Model<PowerCopilotApi> => ({
          ...model,
          provider: "power-copilot",
          baseUrl: modelBaseUrl,
        }),
      );
    },
    api: {
      "anthropic-messages": {
        stream: (model, context, options) =>
          anthropic.stream(model, context, withCopilotBearerAuth(options)),
        streamSimple: (model, context, options) =>
          anthropic.streamSimple(model, context, withCopilotBearerAuth(options)),
      },
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
  const refreshModels = provider.refreshModels;
  let configuredModels: readonly Model<PowerCopilotApi>[] = [];
  return {
    ...provider,
    // Keep the cached catalog's original limits so overrides remain reversible offline.
    getModels: () => configuredModels,
    // Pi 1.1 collections read getAllModels; older Pi versions ignore this extra hook.
    getAllModels: () => configuredModels,
    refreshModels: refreshModels && (async (context) => {
      if (context.stored) {
        configured(
          context.stored.models.filter((model): model is Model<PowerCopilotApi> =>
            model.provider === provider.id && "contextWindow" in model),
        );
      }
      await refreshModels({
        ...context,
        publish: (publication) => context.publish({
          ...publication,
          update: () => {
            publication.update?.();
            configuredModels = configured(provider.getModels());
          },
        }),
      });
    }),
  };
}
