import type { Credential, CredentialStore, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { AuthorizationSession } from "@deepseek-ai/dsh-authorization";
import { credentialKey, type CredentialProvider, type CredentialRecord, type CredentialRef } from "@deepseek-ai/dsh-credentials";

export const HARNESS_CREDENTIAL_KEY = credentialKey("power-copilot", "power-copilot");
const PROVIDER_ID = "power-copilot";

export function toCredential(record: CredentialRecord | undefined): Credential | undefined {
  if (!record) return undefined;
  if (record.kind === "api-key") {
    return { type: "api_key", ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }) };
  }
  return record.payload as Credential;
}

export function toRecord(credential: Credential): CredentialRecord {
  if (credential.type === "api_key") {
    return { kind: "api-key", ...(credential.key === undefined ? {} : { key: credential.key }),
      ...(credential.env === undefined ? {} : { env: { ...credential.env } }) };
  }
  // OAuth metadata may contain explicit undefined values; records require JSON.
  return { kind: "grant", payload: JSON.parse(JSON.stringify(credential)) as unknown };
}

export function harnessCredentialStore(credentials: CredentialProvider, apiKeyRef?: CredentialRef): CredentialStore {
  function check(providerId: string): void {
    if (providerId !== PROVIDER_ID) throw new Error("Power Copilot cannot access another provider's credentials");
  }
  return {
    async read(providerId) {
      check(providerId);
      const stored = toCredential(await credentials.readRecord(HARNESS_CREDENTIAL_KEY));
      if (stored || !apiKeyRef) return stored;
      const value = (await credentials.resolve(apiKeyRef))?.value;
      return value ? { type: "api_key", key: value } : undefined;
    },
    async list() {
      const info = await credentials.describeRecord(HARNESS_CREDENTIAL_KEY);
      return info.configured ? [{ providerId: PROVIDER_ID, type: info.kind === "api-key" ? "api_key" : "oauth" }] : [];
    },
    async modify(providerId, mutate) {
      check(providerId);
      return toCredential(await credentials.modifyRecord(HARNESS_CREDENTIAL_KEY, async (current) => {
        const next = await mutate(toCredential(current));
        return next === undefined ? undefined : toRecord(next);
      }));
    },
    async delete(providerId) {
      check(providerId);
      await credentials.deleteRecord(HARNESS_CREDENTIAL_KEY);
    },
  };
}

export function harnessInteraction(session: AuthorizationSession): ProviderAuthInteraction {
  return {
    signal: session.signal,
    prompt(prompt) {
      const signal = prompt.signal === undefined ? {} : { signal: prompt.signal };
      if (prompt.type === "select") {
        return session.prompt({ ...signal, kind: "select", message: prompt.message, options: prompt.options });
      }
      return session.prompt({ ...signal, kind: prompt.type === "secret" ? "secret" : "text",
        message: prompt.message, placeholder: prompt.placeholder });
    },
    notify(event) {
      switch (event.type) {
        case "device_code":
          session.notify({ message: "Enter this code on the verification page to sign in to Power Copilot.",
            url: event.verificationUri, code: event.userCode });
          break;
        case "auth_url":
          session.notify({ message: event.instructions ?? "Open this page to continue signing in.", url: event.url });
          break;
        case "progress":
          session.notify({ message: event.message });
          break;
        default:
          session.notify({ message: "Signing in to Power Copilot…" });
      }
    },
  };
}
