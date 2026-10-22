import { readFileSync } from "node:fs";
import type { PowerCopilotModelConfig } from "./catalog.ts";

export class ContextWindowError extends Error {
  override name = "ContextWindowError";
}

export function readContextWindows(path: string): ReadonlyMap<string, number> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
    throw new Error(`Power-Copilot could not read configuration "${path}"`, { cause: error });
  }

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`Power-Copilot configuration "${path}" must contain valid JSON`, { cause: error });
  }
  return parseContextWindows(config, path);
}

export function parseContextWindows(config: unknown, path = "power-copilot.json"): ReadonlyMap<string, number> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Power-Copilot configuration "${path}" must be an object`);
  }
  if (Object.keys(config).some((key) => key !== "contextWindows")) {
    throw new Error(`Power-Copilot configuration "${path}" only supports "contextWindows"`);
  }
  if (!("contextWindows" in config)) return new Map();

  const values = config.contextWindows;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error(`Power-Copilot configuration "${path}": contextWindows must be an object`);
  }
  const windows = new Map<string, number>();
  for (const [id, value] of Object.entries(values)) {
    if (!id.trim() || typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `Power-Copilot configuration "${path}": contextWindows requires non-empty model IDs and positive safe integer token counts`,
      );
    }
    windows.set(id, value);
  }
  return windows;
}

export function applyContextWindows<T extends Pick<PowerCopilotModelConfig, "id" | "contextWindow">>(
  models: readonly T[],
  windows: ReadonlyMap<string, number>,
  configPath = "power-copilot.json",
  restartHint = "restart Pi",
): T[] {
  return models.map((model) => {
    const contextWindow = windows.get(model.id);
    if (contextWindow === undefined) return model;
    if (contextWindow >= model.contextWindow) {
      throw new ContextWindowError(
        `Power-Copilot configuration "${configPath}": contextWindows["${model.id}"] must be less than the model maximum (${model.contextWindow} tokens); received ${contextWindow}. Set a positive integer below ${model.contextWindow}, or remove this entry to use the default, then ${restartHint}. Logging in again will not fix this configuration error.`,
      );
    }
    return { ...model, contextWindow };
  });
}
