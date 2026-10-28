import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { loginPowerCopilot as loginWithGitHubOAuth, refreshPowerCopilotToken } from "./oauth.ts";
import { loginPowerCopilotWithGitHubCli, refreshPowerCopilotWithGitHubCli } from "./github-cli.ts";

function adaptOAuthCallbacks(interaction: ProviderAuthInteraction): OAuthLoginCallbacks {
  return {
    onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
    onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }),
    onPrompt: ({ message, placeholder }) => interaction.prompt({ type: "text", message, placeholder }),
    onProgress: (message) => interaction.notify({ type: "progress", message }),
    onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: "Paste the authorization code" }),
    onSelect: (prompt) => interaction.prompt({ type: "select", message: prompt.message, options: prompt.options }),
    signal: interaction.signal,
  };
}

export async function loginPowerCopilot(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const credentials = await loginWithGitHubOAuth(adaptOAuthCallbacks(interaction));
  return { ...credentials, type: "oauth", authMethod: "github-oauth" };
}

/** Pi-only source selector; Harness keeps its explicit GitHub OAuth page flow. */
export async function loginPowerCopilotWithSourceSelection(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  interaction.signal.throwIfAborted();
  const source = await interaction.prompt({
    type: "select", message: "Choose a GitHub credential source",
    options: [
      { id: "github-oauth", label: "GitHub OAuth", description: "Authorize with a browser/device code" },
      { id: "github-cli", label: "GitHub CLI (gh auth token)", description: "Use gh's current account without browser authorization" },
    ],
  });
  interaction.signal.throwIfAborted();
  if (source === "github-cli") return loginPowerCopilotWithGitHubCli(interaction);
  if (source === "github-oauth") return loginPowerCopilot(interaction);
  throw new Error("Unknown GitHub credential source");
}

export async function refreshPowerCopilotCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  if (credential.authMethod === "github-cli") return refreshPowerCopilotWithGitHubCli(credential, signal);
  const refreshed = await refreshPowerCopilotToken(credential, signal);
  return { ...refreshed, type: "oauth", authMethod: "github-oauth" };
}
