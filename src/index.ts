import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginPowerCopilot, refreshPowerCopilotCredential } from "./auth.ts";
import { fetchModelCatalog, type PowerCopilotApi } from "./catalog.ts";
import { COPILOT_REQUEST_HEADERS } from "./copilot-headers.ts";
import { resolvePowerCopilotBaseUrl } from "./oauth.ts";

const DEFAULT_BASE_URL = "https://api.githubcopilot.com";

function createPowerCopilotProvider() {
  return createProvider<PowerCopilotApi>({
    id: "power-copilot",
    name: "Power Copilot",
    baseUrl: DEFAULT_BASE_URL,
    headers: COPILOT_REQUEST_HEADERS,
    auth: {
      apiKey: envApiKeyAuth("Power Copilot API key", []),
      oauth: {
        name: "Power Copilot",
        isSubscription: true,
        login: loginPowerCopilot,
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
      return models.map(
        (model): Model<PowerCopilotApi> => ({
          ...model,
          provider: "power-copilot",
          baseUrl: modelBaseUrl,
        }),
      );
    },
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createPowerCopilotProvider());
}
