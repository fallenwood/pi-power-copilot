# Agent Note: Keep Copilot token renewal independent of model discovery

Status: implemented

English | [中文](2026-10-02-independent-oauth-renewal.zh.md)

## Problem

Copilot access tokens are short-lived, while the GitHub OAuth token stored as the refresh credential allows unattended renewal. Power Copilot exchanges that GitHub token successfully but then requires a full `/models` fetch and catalog parse before returning the renewed credential. A catalog outage, malformed model entry, or exhausted refresh deadline therefore becomes an OAuth failure and prevents Pi from persisting a valid replacement token. Manual device login can appear necessary even though the GitHub credential remains usable.

## Decision

OAuth renewal performs only the Copilot token exchange and preserves the existing credential metadata, including the GitHub refresh token and any previous model-availability snapshot. The provider's separate model-discovery hook owns catalog updates. Pi owns refresh scheduling, credential locking, and persistence; the extension adds no timers or parallel credential store and retains the existing expiry safety margin.

Regression coverage exercises automatic renewal through Pi's model runtime and the registered provider, including concurrent requests, reuse by a new runtime, repeated expiry, failed-exchange retry, and cancellation. Enterprise renewal retains its domain routing and metadata. Documentation distinguishes renewable GitHub OAuth credentials from pasted API keys, which contain no refresh credential.

## Alternatives considered

- Fetch `/models` best-effort during renewal: rejected because even a swallowed catalog error consumes the shared refresh deadline and holds Pi's credential lock. Discovery already has a separate supported hook.

## Consequences

A successful exchange returns immediately for Pi to persist, regardless of catalog availability. Token exchange errors and cancellation still propagate; a failed exchange leaves the stored credential available for retry. Revoked or invalid GitHub credentials still require login, and pasted API keys remain non-renewable. The credential format stays compatible, but its previous `availableModelIds` snapshot is no longer updated by renewal; current model metadata comes from provider discovery instead.
