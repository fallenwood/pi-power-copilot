import childProcess from "node:child_process";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { exchangeForCopilotToken, normalizeGitHubDomain } from "./oauth.ts";

const CLI_TIMEOUT_MS = 10_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
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

async function exchangeCliToken(hostname: string, signal: AbortSignal): Promise<OAuthCredential> {
  const githubToken = await readGitHubCliToken(hostname, signal);
  signal.throwIfAborted();
  const exchangeSignal = AbortSignal.any([signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]);
  const enterpriseDomain = hostname === "github.com" ? undefined : hostname;
  try {
    const exchanged = await exchangeForCopilotToken(githubToken, enterpriseDomain, exchangeSignal, fetch);
    exchangeSignal.throwIfAborted();
    // Do not persist the long-lived GitHub token returned as `refresh` by the exchange helper.
    return {
      type: "oauth", authMethod: "github-cli", refresh: CLI_REFRESH_MARKER,
      access: exchanged.access, expires: exchanged.expires,
      ...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    if (exchangeSignal.aborted) throw new Error("GitHub CLI Copilot token exchange timed out.");
    // Even an unknown-format GitHub token echoed by the server must remain private.
    const status = error instanceof Error ? /\bHTTP (\d{3})\b/.exec(error.message)?.[1] : undefined;
    throw new Error(`GitHub CLI Copilot token exchange failed${status ? ` with HTTP ${status}` : ""}. ` +
      "The CLI token may not be eligible for Copilot. Check account/organization access, or use GitHub OAuth instead.");
  }
}

export async function loginPowerCopilotWithGitHubCli(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  interaction.signal.throwIfAborted();
  const input = await interaction.prompt({
    type: "text", message: "GitHub hostname (leave blank for github.com)", placeholder: "github.com",
  });
  interaction.signal.throwIfAborted();
  const hostname = cliHostname(input);
  interaction.notify({ type: "progress", message: "Reading GitHub CLI credentials and exchanging a Copilot token…" });
  return exchangeCliToken(hostname, interaction.signal);
}

export async function refreshPowerCopilotWithGitHubCli(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  const hostname = cliHostname(typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : "");
  const refreshed = await exchangeCliToken(hostname, signal);
  return { ...credential, ...refreshed };
}
