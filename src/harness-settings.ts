import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type { AuthorizationNotice } from "@deepseek-ai/dsh-authorization";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { HARNESS_CREDENTIAL_KEY } from "./harness-auth.ts";

export const HARNESS_SETTINGS_PATH = "/api/power-copilot";
export interface HarnessSettingsOptions {
  settingsNs: string;
  credentials: CredentialStore;
  reload(signal?: AbortSignal): Promise<void>;
  notifyModelsChanged(): void;
}
interface Attempt {
  id: string;
  method: "oauth" | "api-key";
  status: "pending" | "authorized" | "cancelled" | "error";
  notice?: AuthorizationNotice;
  error?: string;
}

/** Owner-only browser seam. Authorization and credentials never enter a Session or an agent tool. */
export function registerHarnessSettings(ctx: Context, options: HarnessSettingsOptions): void {
  const lifetime = new AbortController();
  let attempt: Attempt | undefined;
  let cancel: AbortController | undefined;
  let running: Promise<void> | undefined;
  let disposed = false;
  let mutating = false;
  async function status() {
    const credential = await options.credentials.read("power-copilot");
    const saved = await ctx.credentials.describeRecord(HARNESS_CREDENTIAL_KEY);
    return { settingsNs: options.settingsNs, configured: credential !== undefined,
      credentialSource: saved.configured ? "saved" : credential ? "reference" : null,
      authType: credential?.type ?? null, attempt: attempt ? { ...attempt } : null };
  }
  function reply(value: unknown, code = 200) {
    return Response.json(value, { status: code, headers: { "Cache-Control": "no-store" } });
  }
  async function begin(method: "oauth" | "api-key", input: string): Promise<void> {
    if (running) throw new Error("already-running");
    const current: Attempt = { id: randomUUID(), method, status: "pending" };
    const controller = new AbortController();
    attempt = current;
    cancel = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(15 * 60 * 1000)]);
    running = (async () => {
      try {
        const outcome = await ctx.authorization.begin({
          key: HARNESS_CREDENTIAL_KEY, method, signal,
          interaction: {
            // These are the shared provider's two defined inputs, not arbitrary agent questions.
            prompt: async (prompt) => {
              if (method === "oauth" && prompt.kind === "text") return input;
              if (method === "api-key" && prompt.kind === "secret") return input;
              throw new Error("Unexpected authorization prompt");
            },
            notify(notice) {
              if (signal.aborted) return;
              // Never publish arbitrary URL schemes to a browser link.
              const url = notice.url ? new URL(notice.url) : undefined;
              current.notice = { message: notice.message,
                ...(url?.protocol === "https:" ? { url: url.href } : {}),
                ...(notice.code ? { code: notice.code } : {}) };
            },
          },
        });
        if (outcome.status === "authorized") {
          try { await options.reload(signal); }
          catch { current.error = "models-unavailable"; }
          if (!disposed) options.notifyModelsChanged();
        }
        current.status = outcome.status;
      } catch {
        current.status = signal.aborted ? "cancelled" : "error";
        if (!signal.aborted) current.error = "authorization-failed";
      } finally {
        // No submitted key or OAuth token is retained in the browser-facing state.
        input = "";
        cancel = undefined;
        running = undefined;
      }
    })();
  }
  ctx.effect(() => {
    const unregister = ctx.connection.fetch.register({
      path: HARNESS_SETTINGS_PATH, methods: ["GET", "POST"], requestBody: "buffered",
      // Connection enforces Host/Origin, authentication, and owner-only admission for exact routes.
      async fetch(request) {
        if (disposed) return reply({ error: "unloaded" }, 503);
        if (request.method === "GET") return reply(await status());
        if (!request.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "invalid-request" }, 415);
        let body: Record<string, unknown>;
        try {
          const value: unknown = await request.json();
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
          body = value as Record<string, unknown>;
        } catch { return reply({ error: "invalid-request" }, 400); }
        if (mutating && (body.action === "begin" || body.action === "cancel" || body.action === "logout")) {
          return reply({ error: "already-running" }, 409);
        }
        switch (body.action) {
          case "begin": {
            if (running) return reply({ error: "already-running" }, 409);
            if (body.method !== "oauth" && body.method !== "api-key") return reply({ error: "invalid-method" }, 400);
            const value = body.method === "oauth" ? body.enterpriseDomain ?? "" : body.apiKey;
            if (typeof value !== "string" || value.length > 65536 || (body.method === "api-key" && !value.trim())) {
              return reply({ error: "invalid-input" }, 400);
            }
            await begin(body.method, value.trim());
            return reply(await status());
          }
          case "cancel": {
            if (typeof body.attemptId !== "string" || body.attemptId !== attempt?.id) return reply({ error: "stale-attempt" }, 409);
            mutating = true;
            try {
              cancel?.abort(new Error("Power Copilot sign-in cancelled"));
              await running;
              return reply(await status());
            } finally { mutating = false; }
          }
          case "logout": {
            // Keep the write fence through record deletion and rediscovery, not just the OAuth runner.
            mutating = true;
            try {
              cancel?.abort(new Error("Power Copilot signed out"));
              ctx.authorization.cancel(HARNESS_CREDENTIAL_KEY);
              await running;
              await ctx.credentials.deleteRecord(HARNESS_CREDENTIAL_KEY);
              attempt = undefined;
              try { await options.reload(lifetime.signal); }
              catch {
                if (!disposed) options.notifyModelsChanged();
                return reply({ ...await status(), warning: "models-unavailable" });
              }
              if (!disposed) options.notifyModelsChanged();
              return reply(await status());
            } finally { mutating = false; }
          }
          case "refresh":
            try { await options.reload(AbortSignal.any([request.signal, lifetime.signal])); }
            catch { return reply({ error: "models-unavailable" }, 502); }
            if (attempt?.error === "models-unavailable") delete attempt.error;
            if (!disposed) options.notifyModelsChanged();
            return reply(await status());
          default: return reply({ error: "invalid-action" }, 400);
        }
      },
    });
    return async () => {
      disposed = true;
      lifetime.abort(new Error("Power Copilot settings unloaded"));
      await running;
      await unregister();
    };
  });
}
