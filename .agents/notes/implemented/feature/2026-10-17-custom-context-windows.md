# Agent Note: Configure per-model context windows below service limits

Status: implemented

English | [中文](2026-10-17-custom-context-windows.zh.md)

## Problem

The discovered catalog always exposes the service's maximum context window. Users cannot select an arbitrary smaller token budget for individual models without relying on generic model overrides that do not validate the service's upper bound.

## Decision

The extension reads `power-copilot.json` from Pi's agent configuration directory at registration. Its optional `contextWindows` object maps exact model IDs to positive safe integer token counts strictly below each discovered maximum. There are no presets or step sizes. Missing configuration and unconfigured models retain their original limits. Unavailable model entries remain inactive until discovery supplies their limits.

Configuration syntax, shape, and integer errors fail registration explicitly. Upper-bound errors are reported through model refresh, including offline cache restoration, while synchronous model reads remain non-throwing. Successfully published catalogs expose the effective windows to Pi's model listing, selection, and context accounting for both authentication methods and all supported APIs. Output-token limits and other capabilities remain unchanged.

Pi's catalog cache retains unmodified service limits; only the published in-memory view uses the configured windows. Configuration changes take effect after restart, and raising or removing an override works with an offline cached catalog. Publication continues to use Pi's generation and cancellation checks. OAuth renewal remains independent of configuration validation and model discovery, as described in [the renewal decision](../bug-fix/2026-10-02-independent-oauth-renewal.md).

Harness applies the same context-window validation through its own Cordis `contextWindows` configuration rather than reading Pi's file. Its process-local catalog and independent runtime ownership are recorded in [the dual-runtime architecture decision](../architecture/2026-10-22-dual-runtime-provider.md). [The Models-provider settings decision](../architecture/2026-10-22-harness-model-provider-settings.md) adds live context-window settings and catalog invalidation while preserving prepared-call snapshots. The Pi configuration and persistent-cache decisions above remain unchanged.

[The OMP adapter decision](../architecture/2026-10-30-omp-provider.md) extends the same bounds and file shape to OMP's own agent directory. Its native cache stores effective windows, so edits require restart and live rediscovery; offline reversal is not available in OMP. This runtime-specific exception does not replace Pi's raw-cache behavior above.

## Alternatives considered

- Use only Pi's `models.json` overrides: these already replace context metadata but do not enforce the discovered maximum, so they do not provide the required validation.
- Persist reduced windows as the catalog limits: rejected because subsequent offline sessions lose the original maximum and cannot reliably raise or remove an override.
- Compute overrides during every synchronous model read: rejected because Pi requires non-throwing model reads and can otherwise hide validation errors as an empty catalog.

## Consequences

The extension adds a provider-specific configuration file without changing credential or catalog storage formats. Invalid refreshes report errors and preserve the last successfully published catalog. A very small window is accepted but may be impractical with Pi's existing compaction reserves or prompt size; this setting does not enlarge service capacity or guarantee request success. Generic `models.json` overrides remain a later Pi configuration layer and should not also set the same context window.

Regression tests cover arbitrary integer budgets and exact boundaries, malformed configuration, both authentication methods, all API routes, raw-cache preservation, offline increases and removal, and explicit refresh errors. The English, Chinese, and translation metadata versions retain matching structure and decisions.
