# Agent Note: Keep Harness provider sign-in inside Models settings

Status: implemented

English | [中文](2026-10-22-harness-model-provider-settings.zh.md)

## Problem

Power Copilot must appear as a configured provider in Harness's Models settings and let the human authorize it there. The original command-driven UX puts provider setup in chat and depends on question cards even though the model page already owns provider configuration. The lack of a generic OAuth editor does not make commands the correct settings surface. This decision supersedes only the command-based authorization UX in [the dual-runtime decision](2026-10-22-dual-runtime-provider.md); that note continues to own shared provider behavior, streaming reuse, catalog snapshots, and independent credentials.

A route registered with `llm` alone has no usable settings address. Harness's settings mirror includes only volatile Config fields, while its Models provider editor supports curated built-in namespaces rather than arbitrary schema-generated provider forms. Declaring a directory entry without an editable namespace therefore does not put this plugin's configured card on the page, and supplying a schema alone does not add OAuth controls.

## Decision

[The Harness entry](../../../../src/harness.ts) declares a configurable-provider directory row for `power-copilot`, with the current Loader entry's `options.id` as `settingsNs` and an empty `settingsPath`. The address denotes this plugin instance's whole configuration, not a profile inside the generic `llm-pi-ai` provider dictionary. The native Models section owns the card, navigation, add-provider machinery, and model picker; the plugin extends only the card's `settings.models.provider-card` area, keyed by the actual settings namespace returned by the Host.

`contextWindows` is a volatile Config field, so the settings mirror contains this namespace and its root-path provider is already configured before authorization. Its automatic plugin-settings form remains available. Runtime discovery reads the current overrides, and a settings change invalidates catalog freshness so the next refresh publishes a new configured model snapshot. Existing prepared calls retain their captured metadata. `apiKeyEnv` remains ordinary static plugin configuration with the existing `POWER_COPILOT_API_KEY` default; it is deliberately absent from the settings mirror. The Models page's generic credential indicator only understands referenced API keys, not the saved OAuth grant, so the card extension owns the accurate login and fallback-credential status rather than presenting a false missing-key indicator.

The ordinary Web Client supplies page-local OAuth and API-key controls, device-code instructions, cancellation, sign-out, and manual model refresh. Its exact `/api/power-copilot` bridge uses the existing Connection service: GET describes non-sensitive status, and POST performs owner-only actions. It neither exposes a generic remote service nor proxies arbitrary credential keys. OAuth reuses the existing authorization flow, interaction mapping, and session commit; API-key input also commits through that flow. Credentials remain in the Host credential store, and tokens never appear in bridge responses, chat, or model-visible questions. Cancellation and disposal stop the pending attempt; only a pending authorization attempt is polled by the Client. Startup metadata failures receive bounded retries and connection/topology-driven recovery rather than permanently losing the slot registration. A Host write fence covers cancellation and the entire sign-out operation, including record deletion and catalog reload, so another tab cannot start an unnoticed authorization in the gap after the previous runner settles.

Successful credential commits and deletion use the existing `credentials/record-updated` notification. Credential-reference changes retain `credentials/reference-updated`, settings changes retain `settings/document-updated`, and explicit catalog or registration changes invalidate through `llm/adapters-updated`. The native Models store and model picker already subscribe to these notifications and reread their Host sources. The extension therefore does not reach into another plugin's store, synthesize a new model-list event, poll the whole Models page, or change the selected model.

[The authentication bridge](../../../../src/harness-auth.ts) keeps the same scoped saved record, serialized OAuth renewal, and saved-login precedence over reference fallback. Sign-out removes the saved login, not an independently configured fallback credential. Pi keeps its own `/login` workflow, configuration directory, and credentials. [The usage guide](../../../../README.md) describes the page flow and the distinction between live context-window settings and static credential-reference configuration.

## Alternatives considered

- Keep slash commands and question cards: rejected because the requested provider setup belongs in Models settings, and a provider-card extension supplies that surface without moving authorization into chat.
- Register only a configurable directory row and standard schema: insufficient because a non-volatile Config has no settings-mirror namespace, and the native provider editor does not render arbitrary provider schemas or OAuth flows.
- Replace the Models page or impersonate the `llm-pi-ai` namespace: rejected because the existing page already owns layout and store refresh, while another provider family's schema and identity are not this plugin's configuration contract.
- Copy OAuth grants into API-key references to satisfy a native badge: rejected because it duplicates secrets, misrepresents renewable OAuth credentials, and changes the independent credential-ownership contract.

## Consequences

Power Copilot remains visible as a configured native provider card before login, with its authentication UI inside the existing Models section. The generic editor is not this provider's sign-in surface. The card's own status is authoritative for its OAuth and fallback authentication; the native page's generic API-key facts are not repurposed as grant status.

Upgrading an already-loaded Host-only package requires restarting the existing Host before refreshing the page. Harness caches Client-manifest metadata, including a negative “no Client” verdict, for the Loader specifier until restart; reinstalling the link does not clear that cache. The plugin does not change its package identity or replace core services merely to bypass this lifecycle.

The Web integration adds a small Client artifact and an owner-only HTTP bridge, not a second application, server, generic remote API, or replacement streaming implementation. Standard invalidation notifications keep the native picker fresh after authorization and explicit refresh, while frozen prepared calls preserve their original catalog view.

Automated checks use synthetic credentials and mocked provider responses. Real GitHub browser authorization and the rendered Models-page appearance are not manually verified by those checks; successful build, registration, or HTTP fixtures do not establish either.
