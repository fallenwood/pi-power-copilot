# Agent Note: Add a native Oh My Pi provider adapter

Status: implemented

English | [中文](2026-10-30-omp-provider.zh.md)

## Problem

Oh My Pi (OMP) 18.14 uses named provider registration, native OAuth callbacks, canonical thinking metadata, and SQLite-backed dynamic discovery rather than Pi 1.x's provider objects. Loading the Pi extension through OMP's compatibility shim cannot supply that contract. The [Pi/Harness architecture](2026-10-22-dual-runtime-provider.md) remains valid for those runtimes but does not make their streaming types interchangeable with OMP's.

## Decision

OMP has its own manifest and extension entry, while Pi's manifest and the Harness export remain unchanged. The adapter shares the runtime-neutral catalog parser, OAuth exchange/renewal, routing, and context-window validation, not the Pi provider factory. Host packages are optional peers, including the original pi-ai package, so an OMP-only installation does not require the Pi or Harness SDKs. Development pins the native packages to 18.14.0; the declared native peer range is 18.14 through 18.x.

OMP's provider registration owns three prefixed API handlers. They rebuild discovered metadata for the corresponding native protocol and delegate to OMP's streaming implementations without replacing built-in APIs or copying stream conversion. Copilot headers are added at request time: OMP's cache deliberately drops extension-owned header resolvers and cannot restore those rows without a trusted fallback. Header-free catalog rows remain usable after restart. The outer host dispatch owns context codecs and provider concurrency permits; inner dispatch disables repeated codec application and permit acquisition. Rebuilding native protocol metadata retains the selected context and output limits.

The `power-copilot` login belongs exclusively to OMP's active credential store. Its method prompt offers device OAuth or a masked API-key prompt, whose plain-string result lets OMP save an ordinary API-key credential. No built-in Copilot login is reused or migrated, and Pi's dynamic GitHub CLI source semantics are not imitated with a saved token or fabricated OAuth expiry. Device codes are adapted to OMP's authorization notices. Token renewal uses the shared exchange independently of model discovery.

OMP's discovery callback receives stored OAuth `access` directly, bypassing `getApiKey` and omitting Enterprise metadata. OMP OAuth access therefore uses an opaque `power-copilot-oauth-v1:` prefix followed by JSON containing `token` and optional `enterpriseUrl`. Discovery decodes both; `getApiKey` returns only the raw token for requests. Refresh unwraps and repacks the access value while retaining the GitHub refresh grant and real expiry. Ordinary unwrapped API keys continue to use existing token-based routing. This envelope is OMP-owned credential data, never a service bearer or catalog field. Malformed envelopes produce a fixed diagnostic without including their contents.

OMP discovery only peeks at unexpired access and does not mint credentials. `/power-copilot-refresh` explicitly resolves this provider's authentication before requesting live discovery, allowing an expired grant with a cold catalog to recover. Normal discovery retains OMP's native 24-hour cache policy. The [context-window decision](../feature/2026-10-17-custom-context-windows.md) continues to own the shared bounds and Pi's reversible raw-cache behavior. OMP reads the same configuration shape from its own active agent directory, but its native cache stores effective windows. Edits require restart and successful live rediscovery; an offline restart retains the previous effective snapshot, including after an override is removed. Native refresh failures can fall back to that snapshot and surface discovery diagnostics.

## Alternatives considered

- Load Pi's existing provider or streaming implementation in OMP: rejected because the provider, transcript, thinking, and authentication contracts differ; compatibility imports do not adapt Pi 1.x provider objects.
- Register ordinary native protocol models with provider/model headers: exercised against the real native registry and rejected because header-bearing cached rows disappear after restart. A provider-wide default base URL also overrides credential-derived Enterprise endpoints, so dynamic models carry their own endpoints instead.
- Share credentials across runtimes or save a GitHub CLI token as a replacement for Pi's dynamic source: not selected because runtime ownership and fresh source resolution must remain explicit; OMP supports device OAuth and pasted API keys without those additional semantics.

## Consequences

OMP uses the same discovered service catalog and bounds while retaining native streaming, credential ownership, profiles, configuration paths, and cache lifecycle. Its prefixed API identifiers and opaque OAuth access envelope are runtime-specific formats. Context-window changes are not reversible offline in OMP; this exception does not change Pi's existing raw-cache decision. After changing accounts, explicit refresh avoids relying on OMP's provider-scoped previous catalog.

Runtime-neutral tests cover device notices, public/Enterprise routing across recreated adapters, raw API-key login, renewal without discovery, cancellation, reasoning translation, configuration bounds, and secret-free diagnostics. The Bun-native suite exercises the actual extension, registry, credential store, all three streaming implementations with fragmented Unicode SSE and usage, request instrumentation, a one-request concurrency limit, expired-grant recovery, Enterprise credential persistence, and effective-window cache restoration and rediscovery. An isolated compiled OMP 18.14.0 CLI smoke run loads the source entry without local SDK dependencies and lists the unauthenticated empty catalog; the agent-directory helper uses the host-provided package root rather than an unavailable compiled subpath. Test processes use isolated directories and synthetic credentials; no real authorization or rendered login UI is verified. Existing Pi/Harness tests and the minimum-Pi runner continue to pass.

The English, Chinese, and translation-metadata files retain aligned sections, paragraphs, lists, and links.
