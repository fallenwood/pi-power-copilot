# Agent Note: Attach Copilot headers and Bearer auth to model requests

Status: implemented

English | [中文](2026-09-23-copilot-model-request-headers.zh.md)

## Problem

Power Copilot declared its IDE identity headers on the provider, but Pi's API adapters assemble chat request headers from each model. Dynamically discovered models therefore sent chat requests without `Editor-Version` and the Copilot API rejected them. Pi's generic Anthropic adapter also sends API-key credentials as `x-api-key`; Copilot requires a Bearer `Authorization` header for Claude's `/messages` endpoint.

## Decision

Every dynamically discovered Power Copilot model carries the complete Copilot request header set, including the editor identity and GitHub API version. The same shared header definition remains available on the provider and is used for model discovery.
Only the Anthropic Messages dispatch converts the current request credential into a Bearer header and clears the generic Anthropic API key. Other adapters retain their existing authentication behavior. Credentials never become static model headers.

## Alternatives considered

- Rely only on provider-level headers: rejected because the current Pi request path does not propagate them to API adapters.
- Patch each API adapter invocation: rejected because model headers are the supported cross-adapter mechanism and avoid duplicating dispatch logic.
- Put the Copilot token in model headers: rejected because a model can outlive a refreshed credential and expose a stale token.
- Reidentify Power Copilot models as the built-in `github-copilot` provider: rejected because it would change the provider identity and invoke unrelated built-in behavior.

## Consequences

OpenAI Responses, OpenAI Completions, and Anthropic Messages requests all receive the required IDE identity consistently. Claude requests use the active credential as Bearer auth without an `x-api-key` header. Changes to the Copilot client identity or API version must update the shared request header definition.
