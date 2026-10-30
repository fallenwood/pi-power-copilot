# Agent Note: Share one Power Copilot provider across Pi and Harness

Status: implemented

English | [中文](2026-10-22-dual-runtime-provider.zh.md)

## Problem

Power Copilot is a Pi extension, but its dynamic catalog, protocol dispatch, and authentication also need to work in DeepSeek Harness. Loading Pi's extension entry in Harness couples registration to Pi's runtime and configuration directory. Maintaining another streaming implementation would duplicate protocol behavior and bypass Harness's existing context conversion, attachment handling, and replay support. Sharing credentials implicitly would also make runtime ownership unclear.

## Decision

[The shared provider factory](../../../../src/provider.ts) owns Power Copilot behavior without importing Pi's coding-agent runtime. [The thin Pi entry](../../../../src/index.ts) selects Pi's configuration path, registers the provider, and restores the catalog through Pi's offline session-start refresh. Both `getModels()` and Pi 1.1's `getAllModels()` expose the configured catalog, so the newer accessor cannot bypass context-window overrides. The existing [request-header decision](../bug-fix/2026-09-23-copilot-model-request-headers.md) and [renewal decision](../bug-fix/2026-10-02-independent-oauth-renewal.md) continue to own those behaviors and their rationale.

[The Harness entry](../../../../src/harness.ts) registers its own `power-copilot` route and reuses the public `PiAiAdapter` rather than implementing streaming or replay again. A management `createModels()` collection owns dynamic discovery and authentication. Each successful catalog publication gives the adapter a provider facade with a captured model list and a new profiles map. The facade does not expose dynamic refresh, so later catalog changes cannot mutate the model view retained by a prepared call. Harness attachment and image-access hooks remain connected to the existing adapter.

Harness resolves authentication before checking catalog freshness. Its catalog has a five-minute freshness interval, concurrent callers share one refresh, and each refresh has a thirty-second timeout. Cancelling one caller withdraws that caller without cancelling another caller's shared work; unloading the plugin cancels runtime work. A renewed OAuth access token does not by itself change the account/catalog identity. The management collection uses only its default in-process catalog store: Harness adds no disk catalog cache, and a process restart requires model discovery again. Only credentials are persisted through the Harness credential service.

[The Harness authentication bridge](../../../../src/harness-auth.ts) restricts saved-record access to `credentialKey("power-copilot", "power-copilot")`, represented as `power-copilot/power-copilot`. A saved login takes precedence; only when no record exists does it resolve the Cordis `apiKeyEnv` credential reference, whose default is `POWER_COPILOT_API_KEY` and whose schema role is `credential-ref`. GitHub OAuth and API-key authorization use Harness notices, prompts, and credential commits; subsequent OAuth refresh uses the credential service's serialized record mutation. The runtime does not read Pi's credential files or provider environment configuration, migrate a Pi login, reuse the built-in GitHub Copilot record, or probe Pi's built-in token variables. Each runtime therefore owns its own authorization even though both use the same provider implementation.

[The Models-provider settings decision](2026-10-22-harness-model-provider-settings.md) supersedes only this integration's original command-based authorization UX, not its shared provider, streaming, catalog, or credential-ownership rationale. The absence of a generic Harness authorization page does not justify putting this provider's sign-in outside Models settings: a small provider-card Client extension supplies the missing surface. The registered authorization flow, credential commits, saved-login priority, and independent token renewal remain in use; no secret-bearing composer argument is introduced.

Harness receives `contextWindows` through Cordis plugin configuration, not Pi's configuration directory. [The context-window decision](../feature/2026-10-17-custom-context-windows.md) remains authoritative for bounds, effective model metadata, and Pi's raw-cache behavior. Harness applies the same validation to its own configuration; its raw and effective catalogs remain in process. The Models-provider settings integration adds live configuration reads and catalog invalidation while preserving the captured model metadata of prepared calls.

[The package manifest](../../../../package.json) keeps Pi's source extension entry and exports emitted JavaScript as the Harness plugin entry. [The build configuration](../../../../tsconfig.build.json) emits JavaScript and rewrites relative TypeScript import extensions. Harness integration packages and Pi's coding-agent package are optional peers, while pi-ai is shared by both runtimes. The Cordis bundle includes localized English and Chinese metadata and an original SVG icon. The Models-provider settings integration adds a small Client extension inside the existing Web application, without changing the adapter or starting a second application.

Development uses pi-ai and Pi coding agent 1.1 with the Harness 0.2.1-rc.2 API. The root development override pins coding agent's `pi-codemode` dependency to 1.1.0 because 1.4 removes an export that this coding-agent version imports. The override repairs this repository's development dependency graph; it is not a consumer dependency constraint or a claim that every version allowed by the peer ranges is validated.

[The OMP adapter decision](2026-10-30-omp-provider.md) extends the package to a third runtime without replacing this Pi/Harness provider factory. OMP uses its native SDK, independent credentials, and native catalog lifecycle; only runtime-neutral catalog, OAuth, routing, and validation code is shared across all three.

## Alternatives considered

- Load the Pi extension directly in Harness: rejected because `ExtensionAPI`, Pi lifecycle hooks, and Pi's configuration directory are not Harness's provider-registration and credential seams.
- Declare only a generic Harness route in YAML: rejected because its configured catalog does not retain this provider's dynamic discovery lifecycle and per-model protocol choice.
- Copy streaming, context conversion, and replay into this package: rejected because the public `PiAiAdapter` already supplies those behaviors, including attachment integration.
- Persist a second Harness catalog or import existing Pi credentials: not selected because a minimal Harness integration needs only an in-process catalog and explicitly owned credentials; additional disk formats and implicit migration add lifecycle and ownership obligations.

## Consequences

Pi retains its existing extension workflow and persistent catalog behavior; Harness gains an independently authorized route using the same provider semantics and Harness's built-in streaming adapter. Harness has a cold catalog after restart and periodically interrogates the service during use. Configuration, credentials, and catalog lifetime remain runtime-specific rather than silently sharing Pi state.

The integration depends on the public `PiAiAdapter` and resolved-profile contract available in the stated Harness version. The development pin and emitted entry keep local builds reproducible without imposing the same transitive override on consumers. Synthetic credentials, fixture endpoints, and successful module loading do not establish that a real user's device login, account access, or rendered Plugin Manager metadata has been verified.

[The minimum-Pi compatibility runner](../../../../scripts/test-pi-minimum.mjs) copies the current source and five original Pi test files into an isolated temporary ESM project, installs pi-ai and Pi coding agent 0.87.1 with install scripts disabled, and preserves child-process failures. Its test process uses temporary configuration directories, excludes secret-bearing environment variables, and rejects real network access. The 26 original tests pass against that minimum version without applying the development dependency override or changing workspace dependencies. Cleanup verifies the original temporary directory's real path and prefix before deleting it.
