import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPowerCopilotProvider } from "./provider.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createPowerCopilotProvider(
    join(getAgentDir(), "power-copilot.json"), undefined, "restart Pi", { githubCliLogin: true },
  ));
  pi.on("session_start", async (_event, context) => {
    const result = await context.modelRegistry.refresh({ allowNetwork: false, providers: ["power-copilot"] });
    const error = result.errors.get("power-copilot");
    if (error) throw error;
  });
}
