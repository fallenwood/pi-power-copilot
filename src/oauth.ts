import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { fetchModelCatalog, normalizeBaseUrl } from "./catalog.ts";
import { COPILOT_API_VERSION, COPILOT_CLIENT_HEADERS } from "./copilot-headers.ts";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";
const ENTERPRISE_BASE_URL = "https://api.enterprise.githubcopilot.com";
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
  expires_in: number;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getResponseErrorDetail(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const detail = [payload.message, payload.error_description, payload.error].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!detail) return undefined;
  return detail
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 300);
}

export function normalizeGitHubDomain(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
}

function getEnterpriseDomain(credentials: OAuthCredentials): string | undefined {
  return typeof credentials.enterpriseUrl === "string"
    ? normalizeGitHubDomain(credentials.enterpriseUrl)
    : undefined;
}

function getCopilotTokenUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/v2/token`;
}

function validateVerificationUri(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub returned an invalid verification URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub returned an invalid verification URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitHub returned an untrusted verification URL");
  }
  return url.href;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: FetchLike,
): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal });
  if (!response.ok) {
    const detail = getResponseErrorDetail(await response.text());
    const diagnostic =
      response.status === 403
        ? " The GitHub token may not be eligible for Copilot, or the account/organization may not have Copilot access."
        : "";
    throw new Error(
      `GitHub Copilot OAuth request failed with HTTP ${response.status}` +
        (detail ? `: ${detail}` : "") +
        diagnostic,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub Copilot OAuth endpoint returned invalid JSON");
  }
}

async function waitForPoll(intervalSeconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalSeconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("GitHub Copilot login cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  if (!isRecord(value)) throw new Error("GitHub returned an invalid device code response");
  const { device_code, user_code, verification_uri, interval, expires_in } = value;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string" ||
    (interval !== undefined && (typeof interval !== "number" || interval < 0)) ||
    typeof expires_in !== "number" ||
    expires_in <= 0
  ) {
    throw new Error("GitHub returned invalid device code response fields");
  }
  return {
    device_code,
    user_code,
    verification_uri: validateVerificationUri(verification_uri),
    interval,
    expires_in,
  };
}

async function startDeviceFlow(domain: string, signal: AbortSignal, fetcher: FetchLike): Promise<DeviceCodeResponse> {
  const value = await fetchJson(
    `https://${domain}/login/device/code`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
    },
    signal,
    fetcher,
  );
  return parseDeviceCodeResponse(value);
}

async function pollForGitHubAccessToken(
  domain: string,
  device: DeviceCodeResponse,
  signal: AbortSignal,
  fetcher: FetchLike,
): Promise<string> {
  const expiresAt = Date.now() + device.expires_in * 1000;
  let intervalSeconds = device.interval ?? 5;
  const url = `https://${domain}/login/oauth/access_token`;

  while (Date.now() < expiresAt) {
    await waitForPoll(intervalSeconds, signal);
    if (Date.now() >= expiresAt) break;
    const value = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "GitHubCopilotChat/0.35.0",
        },
        body: new URLSearchParams({
          client_id: GITHUB_CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
      signal,
      fetcher,
    );

    if (isRecord(value) && typeof value.access_token === "string") return value.access_token;
    if (!isRecord(value) || typeof value.error !== "string") {
      throw new Error("GitHub returned an invalid device token response");
    }
    if (value.error === "authorization_pending") continue;
    if (value.error === "slow_down") {
      intervalSeconds = Math.max(intervalSeconds + 5, typeof value.interval === "number" ? value.interval : 0);
      continue;
    }
    const description = typeof value.error_description === "string" ? `: ${value.error_description}` : "";
    throw new Error(`GitHub device authorization failed: ${value.error}${description}`);
  }

  throw new Error("GitHub device authorization expired");
}

async function exchangeForCopilotToken(
  githubAccessToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
  fetcher: FetchLike,
): Promise<OAuthCredentials> {
  const domain = enterpriseDomain ?? "github.com";
  const value = await fetchJson(
    getCopilotTokenUrl(domain),
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${githubAccessToken}`,
        ...COPILOT_CLIENT_HEADERS,
      },
    },
    signal,
    fetcher,
  );
  if (!isRecord(value) || typeof value.token !== "string" || typeof value.expires_at !== "number") {
    throw new Error("GitHub returned invalid Copilot token response fields");
  }

  return {
    refresh: githubAccessToken,
    access: value.token,
    expires: value.expires_at * 1000 - TOKEN_EXPIRY_SAFETY_MARGIN_MS,
    ...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
  };
}

export function resolvePowerCopilotBaseUrl(token: string, enterpriseDomain?: string): string {
  if (enterpriseDomain) return ENTERPRISE_BASE_URL;

  const proxyEndpoint = /(?:^|;)proxy-ep=([^;]+)/.exec(token)?.[1];
  if (proxyEndpoint) {
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(`https://${proxyEndpoint}`);
    } catch {
      throw new Error("GitHub returned an invalid Copilot proxy endpoint");
    }
    if (proxyUrl.username || proxyUrl.password || proxyUrl.pathname !== "/" || proxyUrl.search || proxyUrl.hash) {
      throw new Error("GitHub returned an invalid Copilot proxy endpoint");
    }
    if (proxyUrl.hostname === "proxy.individual.githubcopilot.com") {
      return DEFAULT_BASE_URL;
    }
    const apiHost = proxyUrl.hostname.replace(/^proxy\./, "api.");
    return normalizeBaseUrl(`https://${apiHost}${proxyUrl.port ? `:${proxyUrl.port}` : ""}`);
  }

  return DEFAULT_BASE_URL;
}

export async function loginPowerCopilot(
  callbacks: OAuthLoginCallbacks,
  fetcher: FetchLike = fetch,
): Promise<OAuthCredentials> {
  const input = await callbacks.onPrompt({
    message: "GitHub Enterprise URL/domain (leave blank for github.com)",
    placeholder: "company.ghe.com",
    allowEmpty: true,
  });
  const enterpriseDomain = normalizeGitHubDomain(input);
  if (input.trim() && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");

  const domain = enterpriseDomain ?? "github.com";
  const signal = callbacks.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const device = await startDeviceFlow(domain, signal, fetcher);
  callbacks.onDeviceCode({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  });

  const githubAccessToken = await pollForGitHubAccessToken(domain, device, signal, fetcher);
  const credentials = await exchangeForCopilotToken(githubAccessToken, enterpriseDomain, signal, fetcher);
  const baseUrl = resolvePowerCopilotBaseUrl(credentials.access, enterpriseDomain);
  const models = await fetchModelCatalog(baseUrl, credentials.access, signal, fetcher);
  return { ...credentials, availableModelIds: models.map((model) => model.id) };
}

export async function refreshPowerCopilotToken(
  credentials: OAuthCredentials,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<OAuthCredentials> {
  const enterpriseDomain = getEnterpriseDomain(credentials);
  const refreshed = await exchangeForCopilotToken(credentials.refresh, enterpriseDomain, signal, fetcher);
  const baseUrl = resolvePowerCopilotBaseUrl(refreshed.access, enterpriseDomain);
  const models = await fetchModelCatalog(baseUrl, refreshed.access, signal, fetcher);
  return { ...credentials, ...refreshed, availableModelIds: models.map((model) => model.id) };
}

export function getPowerCopilotApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}
