import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { withCopilotBearerAuth } from "./anthropic-auth.ts";
import { loginPowerCopilot, refreshPowerCopilotCredential } from "./auth.ts";
import { fetchModelCatalog, type PowerCopilotApi, type PowerCopilotModelConfig } from "./catalog.ts";
import { COPILOT_REQUEST_HEADERS } from "./copilot-headers.ts";
import { applyContextWindows, ContextWindowError, readContextWindows } from "./context-window.ts";
import { resolvePowerCopilotBaseUrl } from "./oauth.ts";

const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

export function createPowerCopilotProvider(
  configPath: string,
  contextWindows = readContextWindows(configPath),
  restartHint = "restart Pi",
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
          return apiKeyLogin(interaction);
        }),
      },
      oauth: {
        name: "Power Copilot",
        isSubscription: true,
        login: async (interaction) => {
          checkLoginConfiguration();
          return loginPowerCopilot(interaction);
        },
        refresh: refreshPowerCopilotCredential,
        toAuth: async (credential) => ({
          apiKey: credential.access,
          baseUrl: resolvePowerCopilotBaseUrl(
            credential.access,
            typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : undefined,
          ),
        }),
      },
    },
    models: [],
    fetchModels: async ({ credential, signal }) => {
      const token =
        credential?.type === "oauth"
          ? credential.access
          : credential?.type === "api_key"
            ? credential.key
            : undefined;
      if (!token) throw new Error("Power Copilot authentication did not provide an access token");

      const enterpriseDomain =
        credential?.type === "oauth" && typeof credential.enterpriseUrl === "string"
          ? credential.enterpriseUrl
          : undefined;
      const modelBaseUrl = resolvePowerCopilotBaseUrl(token, enterpriseDomain);
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
