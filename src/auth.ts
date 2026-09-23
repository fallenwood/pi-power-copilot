import type { OAuthCredential, OAuthCredentials, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { loginPowerCopilot as loginWithGitHubOAuth, refreshPowerCopilotToken } from "./oauth.ts";

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

export async function loginPowerCopilot(
  interaction: ProviderAuthInteraction,
  deviceCodeLogin: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials> = loginWithGitHubOAuth,
): Promise<OAuthCredential> {
  const credentials = await deviceCodeLogin(adaptOAuthCallbacks(interaction));
  return { ...credentials, type: "oauth", authMethod: "github-oauth" };
}

export async function refreshPowerCopilotCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  signal.throwIfAborted();
  const refreshed = await refreshPowerCopilotToken(credential, signal);
  return { ...refreshed, type: "oauth", authMethod: "github-oauth" };
}
