# Agent Note: Keep OAuth login arguments owned by Pi

Status: implemented

English | [中文](2026-09-30-device-login-options.zh.md)

## Problem

Pi 0.99.1 passes a `LoginOptions` object as the second argument to provider OAuth login. Power Copilot used that argument for a test-only device-login function, so `/login` called the options object and failed with `deviceCodeLogin is not a function` before requesting a GitHub device code. The development SDK at 0.87.1 types only the interaction argument, which allowed the conflicting optional parameter to go unnoticed.

## Decision

The registered OAuth login adapter accepts only the interaction and calls the real GitHub OAuth implementation directly. Extra Pi login context is ignored because this flow does not require the app installation ID. Regression coverage invokes the registered provider with login options and exercises device authorization and credential conversion with controlled network responses, rather than replacing the login implementation.

## Alternatives considered

- Wrap the registration to forward only the interaction: rejected because it leaves the conflicting test-only argument on the exported adapter and hides the contract mismatch at one callsite.
- Move function injection to another argument: rejected because provider callback arguments belong to Pi; controlling network responses covers the real authentication path without extending that callback API.

## Consequences

Login works with the single-argument 0.87.1 contract and the options-bearing 0.99.1 contract without changing the minimum peer dependency. GitHub OAuth credentials, refresh behavior, and device-code notifications retain their existing formats. Tests no longer rely on a function-injection argument in the provider login adapter.
