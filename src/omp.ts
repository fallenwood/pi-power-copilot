import { join } from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { PowerCopilotApi } from "./catalog.ts";
import { COPILOT_REQUEST_HEADERS } from "./copilot-headers.ts";
import { createOmpPowerCopilotProvider, OMP_APIS } from "./omp-provider.ts";

export default function (omp: ExtensionAPI): void {
  const provider = createOmpPowerCopilotProvider(join(getAgentDir(), "power-copilot.json"));
  for (const [api, ompApi] of Object.entries(OMP_APIS)) {
    // Provider registration scopes these API handlers to OMP's extension lifecycle.
    // Add constant headers only at request time: OMP cannot restore cached rows
    // carrying extension-owned header resolvers after a process restart.
    omp.registerProvider("power-copilot", {
      api: ompApi,
      streamSimple: (model, context, options) => streamSimple(
        {
          ...buildModel({ ...toModelSpec(model), api: api as PowerCopilotApi }),
          contextWindow: model.contextWindow, maxTokens: model.maxTokens,
          requiresGlyphTokenization: false, // The outer dispatch owns context codecs.
        }, context, {
          ...options, headers: { ...COPILOT_REQUEST_HEADERS, ...options?.headers },
          maxInFlightRequests: {}, // The outer dispatch already owns the provider permit.
        },
      ),
    });
  }
  omp.registerProvider("power-copilot", provider);
  omp.registerCommand("power-copilot-refresh", {
    description: "Renew Power Copilot authentication and refresh its model catalog",
    async handler(_args, context) {
      // OMP's ordinary discovery only peeks at unexpired access. Explicitly
      // resolve auth first, so an expired login and a cold catalog can recover.
      const auth = await context.modelRegistry.getApiKeyWithCredentialForProvider("power-copilot");
      if (!auth) throw new Error("Sign in to Power Copilot with /login before refreshing models");
      await context.modelRegistry.refreshProvider("power-copilot", "online");
      context.ui.notify("Power Copilot model refresh finished", "info");
    },
  });
}
