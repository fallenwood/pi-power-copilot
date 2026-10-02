import type { StreamOptions } from "@earendil-works/pi-ai";

export function withCopilotBearerAuth(options: StreamOptions | undefined): StreamOptions | undefined {
  if (!options?.apiKey) return options;

  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
  return {
    ...options,
    apiKey: undefined,
    headers: { ...headers, authorization: `Bearer ${options.apiKey}` },
  };
}
