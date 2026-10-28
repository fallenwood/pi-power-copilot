import childProcess from "node:child_process";
import type { ApiKeyCredential, AuthResult, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { normalizeGitHubDomain, resolvePowerCopilotBaseUrl } from "./oauth.ts";

const CLI_TIMEOUT_MS = 10_000;
const CLI_REFRESH_MARKER = "github-cli";

function cliError(error: unknown): Error {
  // Child-process errors can contain stdout/stderr (including tokens). Never retain them as causes.
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return new Error("GitHub CLI was not found. Install gh and make it available on PATH.");
  if (error && typeof error === "object" && "killed" in error && error.killed) {
    return new Error("GitHub CLI token command timed out or exceeded its output limit. Check gh auth status in a terminal.");
  }
  return new Error("GitHub CLI could not read a token. Run gh auth login for the selected hostname in a terminal, then try again.");
}

export async function readGitHubCliToken(hostname: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const fail = (error: unknown) => reject(signal.aborted ? signal.reason : cliError(error));
    try {
      const child = childProcess.execFile("gh", ["auth", "token", "--hostname", hostname], {
        encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: 16_384, windowsHide: true, signal,
      }, (error, stdout) => {
        if (error) return fail(error);
        if (signal.aborted) return reject(signal.reason);
        const token = stdout.trim();
        if (!token || /\s/.test(token)) {
          return reject(new Error("GitHub CLI returned an empty or invalid token. Check gh auth status in a terminal."));
        }
        resolve(token);
      });
      // This command is non-interactive; never leave an input prompt waiting behind Pi's UI.
      child.stdin?.end();
    } catch (error) {
      fail(error);
    }
  });
}

function cliHostname(input: string): string {
  if (!input.trim()) return "github.com";
  const hostname = normalizeGitHubDomain(input);
  if (!hostname) throw new Error("Invalid GitHub hostname");
  return hostname;
}

function cliCredential(hostname: string): ApiKeyCredential {
  return { type: "api_key", env: {
    POWER_COPILOT_AUTH_SOURCE: "github-cli", POWER_COPILOT_GITHUB_HOST: hostname,
  } };
}

export function isGitHubCliCredential(credential: ApiKeyCredential | undefined): boolean {
  // An explicit key (including a runtime override) always wins over a source marker.
  return credential?.key === undefined && credential?.env?.POWER_COPILOT_AUTH_SOURCE === "github-cli";
}

export async function resolveGitHubCliAuth(credential: ApiKeyCredential, signal: AbortSignal): Promise<AuthResult> {
  signal.throwIfAborted();
  const hostname = cliHostname(credential.env?.POWER_COPILOT_GITHUB_HOST ?? "");
  const token = await readGitHubCliToken(hostname, signal);
  signal.throwIfAborted();
  return { auth: { apiKey: token, baseUrl: resolvePowerCopilotBaseUrl(
    token, hostname === "github.com" ? undefined : hostname,
  ) }, source: "GitHub CLI" };
}

/** Compatibility for the earlier CLI login stored inside an OAuth credential. */
export async function resolveLegacyGitHubCliAuth(credential: OAuthCredential, signal: AbortSignal): Promise<AuthResult> {
  const hostname = cliHostname(typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : "");
  return resolveGitHubCliAuth(cliCredential(hostname), signal);
}

export async function loginPowerCopilotWithGitHubCli(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
  interaction.signal.throwIfAborted();
  const input = await interaction.prompt({
    type: "text", message: "GitHub hostname (leave blank for github.com)", placeholder: "github.com",
  });
  interaction.signal.throwIfAborted();
  const hostname = cliHostname(input);
  interaction.notify({ type: "progress", message: "Checking GitHub CLI credentials…" });
  // Validate the source, then discard the token. Only non-secret source configuration is saved.
  await readGitHubCliToken(hostname, interaction.signal);
  interaction.signal.throwIfAborted();
  return cliCredential(hostname);
}

export async function refreshPowerCopilotWithGitHubCli(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  const hostname = cliHostname(typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : "");
  await readGitHubCliToken(hostname, signal);
  signal.throwIfAborted();
  // Old records keep their SDK envelope but never persist another CLI token or call exchange.
  return { ...credential, type: "oauth", authMethod: "github-cli", refresh: CLI_REFRESH_MARKER,
    access: "", expires: Number.MAX_SAFE_INTEGER };
}
