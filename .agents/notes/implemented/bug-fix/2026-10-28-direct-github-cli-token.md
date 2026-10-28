# Agent Note: Authenticate with raw GitHub CLI tokens without exchange

Status: implemented

English | [中文](2026-10-28-direct-github-cli-token.zh.md)

## Problem

The user reports that the raw output of `gh auth token` already works as the API key for this same plugin in Harness, while the added `/copilot_internal/v2/token` exchange returns 403. Rejection by that exchange endpoint does not establish that the raw token cannot directly authenticate Copilot requests. Mandatory exchange adds a failing operation to an already usable API-key path.

This decision partially supersedes the [initial CLI-login decision](../feature/2026-10-28-github-cli-login.md): its mandatory-exchange assumption, placement inside OAuth login, OAuth-shaped CLI storage, and expiry-based token retrieval are replaced. That note retains ownership of private fixed-argv execution, cancellation, bounded output, error redaction, avoiding long-lived token copies, and runtime separation.

## Decision

Pi offers GitHub CLI under API-key login, alongside Paste API key. CLI login normalizes the hostname, runs gh to validate token availability, discards the output, and saves an `api_key` credential without a `key`. Only `env.POWER_COPILOT_AUTH_SOURCE: github-cli` and `env.POWER_COPILOT_GITHUB_HOST` are stored. No device authorization, internal token exchange, or catalog request occurs inside that login helper.

Each auth resolution privately runs gh again and returns its current raw output as the request API key. Existing model discovery and all three streaming protocols send it as Bearer authentication, using the existing proxy/Enterprise base-URL routing. CLI availability checks inspect only the exact source marker and do not execute commands. An explicit `key`, including an empty string, takes precedence over the marker, preserving runtime key overrides. Failed resolution leaves the source configuration unchanged for the next retry rather than caching a failed or stale token.

Existing saved OAuth records with `authMethod: github-cli` remain readable. Their auth and model-discovery paths obtain raw gh output dynamically even when the stored record is not expired. If an old record requires refresh, the compatibility helper only validates gh, clears `access`, replaces `refresh` with the fixed CLI marker, and sets `expires` to `Number.MAX_SAFE_INTEGER` while retaining Enterprise and other metadata. This does not claim that a token has infinite validity: authentication still reads gh each time. Signing in again migrates the login to the new API-key source representation.

The shared provider leaves CLI selection and resolution disabled by default, so Harness's existing browser authorization and pasted API-key paths remain unchanged. Pi's original browser OAuth flow also remains unchanged, including its separate token exchange and renewal. The CLI correction does not introduce silent fallback or move credentials between runtimes.

## Alternatives considered

- Retain mandatory Copilot token exchange: not selected because the user observes 403 at that endpoint despite successful direct use of the same raw token.
- Put raw gh output in OAuth `access` with a fabricated expiry: not selected because it misrepresents an external API-key source as an OAuth grant and copies a long-lived secret into storage.
- Use Pi's generic `!gh auth token` key configuration: not selected for this integration because it uses generic shell execution and process-lifetime output caching; the existing private fixed-argv runner supports fresh resolution without those semantics.
- Remove browser OAuth: not selected because direct CLI credentials and browser authorization are distinct explicit choices; fixing CLI semantics does not require deleting the existing flow.

## Consequences

CLI login no longer depends on the token-exchange endpoint accepting the CLI app's token. Account or token-environment changes in gh affect the next auth resolution, not a synthetic Copilot expiry. `gh` remains required on Pi's inherited PATH, and direct service requests still enforce account access and organization policy. The working direct-token report comes from the user; automated checks do not read real credentials or independently establish acceptance of that user's token.

Synthetic-command tests retain the previous runner safety coverage and assert zero device/exchange/catalog fetches in CLI login, resolution, and compatibility refresh. They cover exact marker matching, explicit-key precedence, fresh raw-token reads, GitHub/Enterprise/proxy routing, storage without token copies, metadata preservation, cancellation, and retry after failures. Registered-provider tests cover actual discovery and protocol dispatch separately. The English, Chinese, and translation-metadata files retain aligned sections, paragraphs, lists, and links.
