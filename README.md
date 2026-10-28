# Power Copilot Provider

One package for **Pi coding agent** and **DeepSeek Harness**. Both runtimes register a `power-copilot` provider and discover models from the Copilot-compatible `GET /models` endpoint. Model IDs and capabilities are not embedded in the plugin.

## Pi coding agent

Install the package with Pi's package manager, or load the extension directly during development:

```sh
pi --extension ./src/index.ts
```

Use `/login`, select **Power Copilot**, then choose **API key** to select **GitHub CLI (gh auth token)** or **Paste API key**. Pasting uses Pi's standard secret-entry flow. The separate **OAuth** option retains GitHub's browser/device authorization flow. Credentials belong to the separate `power-copilot` provider; the plugin does not read or reuse the built-in `github-copilot` credential.

### Use GitHub CLI instead of browser authorization

Install GitHub CLI (`gh`) and sign in from a terminal before using Pi:

```sh
gh auth login --hostname github.com
gh auth status --hostname github.com
```

In Pi, run `/login` → **Power Copilot** → **API key** → **GitHub CLI (gh auth token)**. Leave the hostname blank for `github.com`, or enter your GitHub Enterprise hostname. The plugin privately executes `gh auth token --hostname <hostname>` and sends its **raw output directly as the Copilot API bearer token**, exactly like a manually supplied API key. It does not call `/copilot_internal/v2/token`, request a device code, or start browser authorization. `gh` must be on the PATH inherited by Pi.

Login validates the CLI source and saves only an `api_key` credential with `env.POWER_COPILOT_AUTH_SOURCE: github-cli` and `env.POWER_COPILOT_GITHUB_HOST: <hostname>`, without a `key` or token value. Each authentication resolution and network catalog discovery re-reads gh; no artificial token expiry or OAuth renewal is involved. Switching gh's active account or token environment affects the next resolution. Availability checks do not execute gh. Failures leave the source configuration intact for retry, without falling back to browser authorization. The non-interactive command has a ten-second timeout and bounded private output.

An exchange endpoint's 403 does **not** establish that the same token is unusable directly: a raw gh token can work through the API-key path while exchange is denied. Direct access still depends on the token/account/service permissions. Earlier CLI logins stored in an OAuth-shaped record also bypass exchange and read gh directly; sign in through the new **API key** menu to replace that legacy record. Do not run the token command in chat or paste its output into chat. This CLI option is Pi-only; Harness's Models-page sign-in remains unchanged.

Pi versions from 0.87.1 through 1.x are supported (validated with 0.87.1 and 1.1.0). The package's `pi.extensions` entry remains unchanged; Pi does not load the Harness entry point.

### Custom context windows in Pi

Create `power-copilot.json` in Pi's agent configuration directory (normally `~/.pi/agent`, or the directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "contextWindows": {
    "gpt-5.3-codex": 123456
  }
}
```

Restart Pi after editing the file. Missing files, an empty object, and unconfigured models retain the advertised maximum. Remove an entry to restore its maximum. Malformed JSON, unsupported fields, and file-read failures other than a missing file are reported.

Overrides also apply to cached catalogs. Pi's cache retains the service's original limits, so increasing or removing an override does not require another network fetch. Avoid also overriding `contextWindow` for the same model in Pi's `models.json`, whose overrides are applied after provider metadata.

## DeepSeek Harness

The package also exports a **Cordis bundle with a Host adapter and a small Web Client extension**. Power Copilot appears as a provider card inside Harness's existing **Settings → Models** page; it does not replace the page or start another Web server. The current adapter targets **Harness 0.2.1-rc.2**, its matching `@deepseek-ai/dsh-llm-pi-ai` package, and **pi-ai 1.1.x**. Older Harness prereleases are not supported. Harness dependencies are optional peers, so Pi-only consumers do not need them; conversely Harness does not import `pi-coding-agent`.

### Build and install

For a source checkout:

```sh
npm ci --ignore-scripts
npm run build
```

In Harness's plugin manager, install this checkout's absolute directory as a local bundle. Packaged distributions build their JavaScript during `npm pack` and include the compiled entry point, patch, locales, and icon. Do not point Harness directly at the Pi TypeScript extension.

If upgrading from the earlier Host-only integration, **restart the existing Harness service, then refresh the page**. Harness caches package Client-manifest metadata, including a previous “no Client” result, until Host restart; reinstalling the linked bundle and refreshing the page alone cannot invalidate that cache. Keep the same profile and GUI URL.

The bundle inserts the `power-copilot` row and declares its settings address in Harness's configurable-provider directory. The Host adapter needs the `llm` and `credentials` services; page sign-in also uses the normal Web profile's Connection and `authorization` services. The adapter reuses Harness's existing `PiAiAdapter` for streaming, tool calls, replay, and attachments, without modifying the generic `llm-pi-ai` provider configuration.

### Sign in and select a model

Open **Settings → Models → Power Copilot**. The provider card is present while the plugin is configured, including before sign-in. Its extension area contains the Power Copilot authentication controls; Harness's generic provider editor is not the sign-in surface for this provider. Harness does not need a chat command or a question card for this flow.

For **GitHub OAuth**, start sign-in in the card. For GitHub Enterprise, provide your Enterprise domain (for example `company.ghe.com`). The card displays the verification URL and device code while authorization proceeds. Open the URL, enter the code, and authorize in your browser. The card reports completion; use its **Cancel** action to stop an outstanding attempt.

For an **API key**, use the card's secret-entry field and save it there. Alternatively, set `POWER_COPILOT_API_KEY` in the Harness process environment before launch, or store that credential reference through Harness's credential settings. The plugin's static `apiKeyEnv` configuration can name a different reference. The reference is resolved per operation and is used only when there is no saved Power Copilot login. Do not paste tokens into chat.

The card reports its own saved-login and fallback-credential status because Harness's generic API-key indicator does not describe OAuth grants. Its actions use an owner-only Host bridge; credentials stay on the Host and tokens are never returned to the page or sent to the model. Polling runs only while an authorization attempt is pending.

Select a model under **Power Copilot** in the existing model picker. Use the card's **Refresh models** action to request immediate rediscovery; credential and catalog changes also invalidate Harness's native model picker. Installing the bundle or signing in does not change your selected model.

Harness stores the plugin's saved login at `power-copilot/power-copilot` in its credential store, independently of Pi and of Harness's built-in Copilot login. No credentials are imported or migrated automatically. Use the card's **Sign out** action to remove the saved login. A configured API-key reference still applies afterward; unset it as well to disconnect completely.

Discovery also runs on demand when a model list or request is resolved, with concurrent refreshes coalesced and a five-minute in-process catalog lifetime. A changed sign-in triggers rediscovery; signing out clears the saved account's catalog, and a remaining fallback credential can discover its own catalog. Catalog requests have a 30-second deadline and are cancelled when the plugin unloads. Successful refreshes publish a new model snapshot, so an already prepared call keeps its original metadata. Unloading the plugin also cancels active streams, including prepared calls. Catalogs are **not persisted across Harness restarts**: the first discovery after restart needs network access. OAuth credentials and renewed tokens are persisted.

### Custom context windows in Harness

Use the plugin's automatically generated settings form to edit `contextWindows`. This field is live (`volatile`): applying a change invalidates the current catalog, and the next discovery publishes models with the new limits. Calls already prepared keep their captured metadata. The separate `apiKeyEnv` option remains static plugin configuration, not a Models-page credential-status field.

For file-based configuration, override the inserted row in your profile patch (the complete row `config` is replaced):

```yaml
- id: power-copilot
  config:
    contextWindows:
      gpt-5.3-codex: 123456
```

Apply the profile patch after editing. The same bounds below apply. The plugin never reads `~/.pi/agent/power-copilot.json` in Harness.

## Shared authentication and model behavior

The OAuth flow requests a GitHub device code and exchanges the GitHub OAuth token for a short-lived Copilot token. Both runtimes renew the Copilot token using the stored GitHub token and persist the renewed credential. Ordinary expiry does not require another device login. Token renewal is independent of model discovery, so a catalog outage cannot invalidate a successful renewal. A revoked or invalid GitHub token still requires signing in again.

API-key login stores only the pasted token, with no refresh credential. If you paste a short-lived Copilot token, replace it when it expires. Choose **GitHub OAuth** for automatic renewal.

The API host is derived from the credential. Enterprise OAuth uses `https://api.enterprise.githubcopilot.com`; otherwise the plugin uses the token's Copilot proxy endpoint or `https://api.githubcopilot.com`.

The `/models` response must contain a `data` array in the Copilot model format. Chat models need `id`, `name`, `capabilities.limits.max_context_window_tokens`, and `capabilities.limits.max_output_tokens`. `capabilities.supports.vision` and `capabilities.supports.reasoning_effort` configure model capabilities. Models marked `model_picker_enabled: false`, non-chat models, and models without a supported `/responses`, `/chat/completions`, or `/messages` endpoint are omitted.

For each model the plugin prefers Responses, then Anthropic Messages, then Chat Completions. Both runtimes use pi-ai streaming implementations and send the current credential as Bearer authentication, including Claude's Anthropic Messages route (not `x-api-key`). Tokens and provider response bodies are not logged.

### Context-window validation

Keys are exact model IDs from `/models`. Each value is a token count: any positive safe integer **strictly less than** the model's `max_context_window_tokens` is accepted, without presets or step sizes. For a 400000-token maximum, 1 through 399999 are valid. Zero, negative numbers, fractions, strings, and values at or above the maximum are rejected, not silently clamped.

Entries for unavailable models remain inactive; their upper bounds are checked when those models become available. Both authentication methods and all three protocols use the effective window. Only `contextWindow` changes; routing, reasoning capabilities, and output-token limits stay unchanged. The effective window drives the runtime's context accounting and compaction, but does not change server capacity or guarantee that a prompt fits a very small window. Adjust compaction reserves accordingly.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:pi-minimum
npm run typecheck
npm run build
npm pack --dry-run
```

In confined Windows environments that disallow the test runner's subprocess stdio pipes, use `node --experimental-strip-types --test --test-isolation=none test/*.test.ts` and `npm run test:pi-minimum -- --test-isolation=none` for same-process tests; normal subprocess isolation remains the default.

Tests use synthetic credentials and mocked HTTP/SSE responses, exercising the real pi-ai protocol implementations and Harness adapter without contacting GitHub, running the real `gh auth token`, or reading user credentials. Real GitHub CLI token eligibility, browser authorization, and the rendered Models-page appearance have not been manually verified; automated checks do not establish any of them. Development pins the Pi coding agent's codemode dependency to 1.1.0 because newer codemode releases remove an export used by that SDK version; this repository-level override does not change consumers' dependency resolution.
