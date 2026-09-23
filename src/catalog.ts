import { COPILOT_REQUEST_HEADERS } from "./copilot-headers.ts";

export type PowerCopilotApi = "openai-responses" | "openai-completions" | "anthropic-messages";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PowerCopilotModelConfig {
  id: string;
  name: string;
  api: PowerCopilotApi;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers: Record<string, string>;
}

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

const apiEndpoints: ReadonlyArray<[PowerCopilotApi, string]> = [
  ["openai-responses", "/responses"],
  ["anthropic-messages", "/messages"],
  ["openai-completions", "/chat/completions"],
];

const thinkingLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, field: string, modelId: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Power-Copilot model "${modelId}" has an invalid ${field}`);
  }
  return value;
}

function selectApi(value: unknown): PowerCopilotApi | undefined {
  if (!Array.isArray(value) || !value.every((endpoint) => typeof endpoint === "string")) {
    return undefined;
  }
  for (const [api, suffix] of apiEndpoints) {
    if (value.some((endpoint) => endpoint.endsWith(suffix))) return api;
  }
  return undefined;
}

function getThinkingCapabilities(supports: JsonObject): {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
} {
  const effort = supports.reasoning_effort;
  if (effort === undefined) return { reasoning: false };
  if (!Array.isArray(effort) || !effort.every((level) => typeof level === "string")) {
    throw new Error("Power-Copilot returned an invalid reasoning_effort capability");
  }

  const supportedLevels = new Set(effort);
  const reasoning = thinkingLevels.some((level) => supportedLevels.has(level));
  if (!reasoning) return { reasoning: false };

  const thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> = {};
  thinkingLevelMap.off = supportedLevels.has("none") ? "none" : null;
  for (const level of thinkingLevels) {
    thinkingLevelMap[level] = supportedLevels.has(level) ? level : null;
  }
  return { reasoning, thinkingLevelMap };
}

export function parseModelCatalog(payload: unknown): PowerCopilotModelConfig[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Power-Copilot /models response must contain a data array");
  }

  const models: PowerCopilotModelConfig[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry)) throw new Error("Power-Copilot /models contains an invalid model entry");
    if (entry.model_picker_enabled === false) continue;
    if (entry.model_picker_enabled !== undefined && typeof entry.model_picker_enabled !== "boolean") {
      throw new Error("Power-Copilot /models contains an invalid model_picker_enabled value");
    }

    const capabilities = entry.capabilities;
    if (!isRecord(capabilities)) throw new Error("Power-Copilot /models model is missing capabilities");
    if (capabilities.type !== "chat") continue;

    const api = selectApi(entry.supported_endpoints);
    if (!api) continue;

    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("Power-Copilot /models contains a chat model without an id");
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      throw new Error(`Power-Copilot model "${entry.id}" is missing its display name`);
    }

    const limits = capabilities.limits;
    if (!isRecord(limits)) throw new Error(`Power-Copilot model "${entry.id}" is missing limits`);
    const supports = capabilities.supports;
    if (supports !== undefined && !isRecord(supports)) {
      throw new Error(`Power-Copilot model "${entry.id}" has invalid supports metadata`);
    }
    const modelSupports = isRecord(supports) ? supports : {};
    const thinking = getThinkingCapabilities(modelSupports);

    models.push({
      id: entry.id,
      name: entry.name,
      api,
      reasoning: thinking.reasoning,
      ...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
      input: modelSupports.vision === true ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: positiveSafeInteger(limits.max_context_window_tokens, "max_context_window_tokens", entry.id),
      maxTokens: positiveSafeInteger(limits.max_output_tokens, "max_output_tokens", entry.id),
      headers: { ...COPILOT_REQUEST_HEADERS },
    });
  }

  return models;
}

export function normalizeBaseUrl(rawBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("Power-Copilot API base URL must be a valid absolute URL");
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
    throw new Error("Power-Copilot API base URL must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Power-Copilot API base URL must not contain credentials, a query, or a fragment");
  }

  return url.toString().replace(/\/+$/, "");
}

export async function fetchModelCatalog(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<PowerCopilotModelConfig[]> {
  if (!token.trim()) throw new Error("A Power-Copilot access token is required to refresh models");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const response = await fetcher(`${normalizedBaseUrl}/models`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...COPILOT_REQUEST_HEADERS,
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Power-Copilot model discovery failed with HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Power-Copilot /models returned invalid JSON");
  }
  return parseModelCatalog(payload);
}
