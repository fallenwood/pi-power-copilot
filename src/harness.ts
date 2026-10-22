import type { Context, Volatile } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-authorization";
import type {} from "@deepseek-ai/dsh-settings";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { registerHarnessSettings } from "./harness-settings.ts";
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy,
  type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import { createModels, type CredentialStore, type Provider } from "@earendil-works/pi-ai";
import { createPowerCopilotProvider } from "./provider.ts";
import { parseContextWindows } from "./context-window.ts";
import { HARNESS_CREDENTIAL_KEY, harnessCredentialStore, harnessInteraction, toRecord } from "./harness-auth.ts";

export const name = "power-copilot";
export const inject = ["llm", "credentials"];
export interface Config {
  /** Credential reference used only when no saved Power Copilot login exists. */
  apiKeyEnv: string;
  /** Exact model IDs mapped to token budgets strictly below the service maximum. */
  contextWindows: Volatile<Record<string, number>>;
}
export const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default("POWER_COPILOT_API_KEY"),
  contextWindows: z.dict(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).default({}).volatile(),
});
const ID = "power-copilot";
const CATALOG_TTL_MS = 5 * 60 * 1000;

/** Dynamic catalog owner; every publication gives the streaming adapter a frozen view. */
export function createHarnessRuntime(credentials: CredentialStore,
  windows: Record<string, number> | (() => Record<string, number>) = {},
  hooks: Pick<PiAiAdapterOptions, "resolveAttachments" | "resolveImageAccess" | "onReplayDegrade"> = {}) {
  const readWindows = () => parseContextWindows({ contextWindows: typeof windows === "function" ? windows() : windows },
    "Harness Power Copilot configuration");
  const contextWindows = new Map(readWindows());
  const windowIdentity = () => JSON.stringify([...readWindows()].sort(([a], [b]) => a.localeCompare(b)));
  const provider = createPowerCopilotProvider("Harness Power Copilot configuration",
    contextWindows, "refresh Power Copilot models");
  const lifetime = new AbortController();
  const auth = { credentials, authContext: { env: async () => undefined, fileExists: async () => false } };
  const models = createModels(auth);
  models.setProvider(provider);
  let profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>;
  function publish(catalog = [...provider.getModels()]): void {
    const frozen: Provider = { ...provider, getModels: () => catalog, getAllModels: () => catalog, refreshModels: undefined };
    profiles = new Map([[ID, {
      provider: ID, displayName: "Power Copilot", piProvider: frozen,
      streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024,
      requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024,
      retryPolicy: resolveRetryPolicy(undefined, "power-copilot"),
      modelErrors: new Map(), configuredMaxTokens: new Map(),
    }]]);
  }
  publish();
  let lastCredential: string | undefined;
  let refreshedAt = 0;
  let lastWindows: string | undefined;
  let pending: Promise<void> | undefined;
  async function credentialIdentity(): Promise<string | undefined> {
    const credential = await credentials.read(ID);
    // A renewed short-lived access token is still the same account/catalog.
    return JSON.stringify(credential?.type === "oauth"
      ? { refresh: credential.refresh, enterpriseUrl: credential.enterpriseUrl }
      : credential);
  }
  async function refresh(signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)])): Promise<void> {
    // Resolve (and renew) auth independently of discovery, under the credential-store lock.
    const resolved = await models.getAuth(ID, { signal });
    if (!resolved) {
      publish([]);
      lastCredential = undefined;
      refreshedAt = 0;
      return;
    }
    const signature = await credentialIdentity();
    const nextWindows = windowIdentity();
    if (signature === lastCredential && nextWindows === lastWindows && Date.now() - refreshedAt < CATALOG_TTL_MS) return;
    if (signature !== lastCredential || nextWindows !== lastWindows) publish([]);
    contextWindows.clear();
    for (const [key, value] of readWindows()) contextWindows.set(key, value);
    const result = await models.refresh({ providers: [ID], signal });
    const error = result.errors.get(ID);
    if (error) throw error;
    signal.throwIfAborted();
    if (signature !== await credentialIdentity() || nextWindows !== windowIdentity()) {
      // A sign-in changed while discovery was in flight; never expose the previous account's catalog.
      publish([]);
      lastCredential = undefined;
      refreshedAt = 0;
      return refresh(signal);
    }
    publish();
    lastCredential = signature;
    lastWindows = nextWindows;
    refreshedAt = Date.now();
  }
  function ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // One shared catalog refresh; an individual caller can withdraw without cancelling others.
    pending ??= refresh().finally(() => { pending = undefined; });
    if (!signal) return pending;
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending!.then(() => { signal.removeEventListener("abort", abort); resolve(); },
        (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
  function withLifetime(options: GenerateOptions): GenerateOptions {
    return { ...options, signal: options.signal
      ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal };
  }
  class PowerCopilotAdapter extends PiAiAdapter {
    override async listModels(route: string) {
      await ready();
      if (!(await credentials.read(ID))) return [];
      return super.listModels(route);
    }
    override async resolveModel(route: string, model: string, signal?: AbortSignal) {
      await ready(signal);
      return super.resolveModel(route, model, signal);
    }
    override async prepareCall(route: string, model: string, signal?: AbortSignal) {
      await ready(signal);
      const prepared = await super.prepareCall(route, model, signal);
      return { ...prepared, stream: (options: GenerateOptions) => prepared.stream(withLifetime(options)) };
    }
    override async * stream(options: GenerateOptions) {
      const request = withLifetime(options);
      await ready(request.signal);
      yield* super.stream(request);
    }
  }
  const adapter = new PowerCopilotAdapter({
    ...hooks, profiles: () => profiles, auth,
    resolveApiKey: async () => {
      if (!(await models.getAuth(ID, { signal: lifetime.signal }))) throw new LlmError("Sign in to Power Copilot first", "MISSING_CREDENTIAL");
      // Let the shared provider use its stored credential, including enterprise endpoint and renewal.
      return undefined;
    },
  });
  return { adapter, provider, models,
    async reload(signal?: AbortSignal) { refreshedAt = 0; await ready(signal); },
    dispose: () => lifetime.abort(new Error("Power Copilot plugin unloaded")) };
}

export function apply(ctx: Context, config: Config): void {
  const credentials = harnessCredentialStore(ctx.credentials, credentialRef(config.apiKeyEnv));
  const runtime = createHarnessRuntime(credentials, () => config.contextWindows.get(), {
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
      hostPath => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
    onReplayDegrade: ({ reason }) => ctx.logger.warn(`Power Copilot: unusable replay metadata (${reason})`),
  });
  const settingsNs = ctx.fiber.entry?.options.id ?? ID;
  const directory = [{ provider: ID, displayName: "Power Copilot", settingsNs, settingsPath: [],
    nativeAuth: { env: [config.apiKeyEnv], oauth: true } }];
  let notifyModelsChanged = () => {};
  ctx.effect(() => {
    const unregister = ctx.llm.registerAdapter([ID], runtime.adapter);
    const registration = ctx.llm.registerConfigurableProviders(directory);
    notifyModelsChanged = () => { registration.replace(directory); };
    return () => { runtime.dispose(); registration(); unregister(); };
  });
  ctx.inject(["authorization"], (authorized) => {
    authorized.effect(() => authorized.authorization.registerFlow({
      key: HARNESS_CREDENTIAL_KEY, label: "Power Copilot",
      methods: [{ id: "oauth", label: "GitHub OAuth" }, { id: "api-key", label: "API key" }],
      async run(session) {
        const interaction = harnessInteraction(session);
        const credential = session.method === "oauth"
          ? await runtime.provider.auth.oauth!.login(interaction)
          : await runtime.provider.auth.apiKey!.login!(interaction);
        session.signal.throwIfAborted();
        await session.commit(toRecord(credential));
      },
    }));
    authorized.inject(["connection"], (connected) => {
      registerHarnessSettings(connected, { settingsNs, credentials, reload: (signal) => runtime.reload(signal), notifyModelsChanged });
    });
  });
}
