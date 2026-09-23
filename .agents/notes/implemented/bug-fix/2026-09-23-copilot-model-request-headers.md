# Agent Note: Attach Copilot headers to discovered models

Status: implemented

English | [中文](2026-09-23-copilot-model-request-headers.zh.md)

## Problem

Power Copilot declared its IDE identity headers on the provider, but Pi's API adapters assemble chat request headers from each model. Dynamically discovered models therefore sent chat requests without `Editor-Version` and the Copilot API rejected them.

## Decision

Every dynamically discovered Power Copilot model carries the complete Copilot request header set, including the editor identity and GitHub API version. The same shared header definition remains available on the provider and is used for model discovery.

## Alternatives considered

- Rely only on provider-level headers: rejected because the current Pi request path does not propagate them to API adapters.
- Patch each API adapter invocation: rejected because model headers are the supported cross-adapter mechanism and avoid duplicating dispatch logic.

## Consequences

OpenAI Responses, OpenAI Completions, and Anthropic Messages requests all receive the required IDE identity consistently. Changes to the Copilot client identity or API version must update the shared request header definition.
