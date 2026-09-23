# Agent Note: Use the first discovered model as the default

Status: proposed

English | [中文](2026-09-23-first-dynamic-model-default.zh.md)

## Problem

After Power Copilot authentication, Pi reports that no default model is configured for the `power-copilot` provider. The provider discovers its model catalog dynamically, so it cannot declare an account-specific first model before authentication.

## Proposal

After successful authentication, refresh the authenticated Power Copilot model catalog and use its first usable model as the default only when the session has no model selected. Persist the selection through a supported Pi API so it remains the default for subsequent sessions. Apply the behavior to both OAuth and API-key authentication. If discovery fails or returns no usable models, keep authentication successful and direct the user to `/model`.

This requires Pi core support for choosing a provider's default from a dynamically refreshed catalog. The current provider extension API does not expose a way to register that default for Pi's post-login selection logic.

## Alternatives considered

- Keep requiring the user to choose with `/model`: reliable with the current API, but it does not meet the requested automatic default behavior.
- Hard-code a model ID: rejected because the catalog is dynamic and can vary by account.
- Mutate Pi's internal default-provider map from the extension: rejected because it is not a supported extension API and would couple the plugin to Pi internals.

## Acceptance criteria

- OAuth and API-key login use the first usable model in the authenticated catalog when no model is already selected.
- The chosen provider and model are persisted as the default through a supported Pi API.
- An existing model selection is not overwritten.
- An empty or unavailable catalog does not undo successful authentication and leaves `/model` available for manual selection.

## Risks

- A catalog refresh failure must not be reported as an authentication failure.
- Selecting by catalog order makes the provider's model ordering observable behavior; changes to the service's ordering can change the default.
- The feature cannot be completed safely in the extension alone until Pi provides a supported post-login default-selection hook or equivalent configuration.
