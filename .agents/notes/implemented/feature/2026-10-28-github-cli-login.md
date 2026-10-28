# Agent Note: Use GitHub CLI credentials for Pi Power Copilot

Status: implemented

English | [中文](2026-10-28-github-cli-login.zh.md)

## Problem

Pi users already signed in through GitHub CLI need a Power Copilot login without another browser/device authorization. Configuring `!gh auth token` as an API key only supplies a GitHub token, while Power Copilot model discovery and requests need an exchanged Copilot token. Copying the CLI token into another credential store also duplicates a long-lived secret and disconnects renewal from gh's current credentials.

## Decision

Pi explicitly enables a GitHub-source selector inside its renewable login option. The choices are the existing GitHub OAuth device flow and GitHub CLI. The shared provider defaults to the existing device flow, so Harness's Models page, authorization prompts, and credential ownership remain unchanged under the [dual-runtime decision](../architecture/2026-10-22-dual-runtime-provider.md).

The CLI flow executes the fixed executable `gh` with `auth token --hostname <normalized-hostname>` as separate arguments, without a shell or arbitrary command configuration. The command is non-interactive, accepts cancellation, and has a ten-second timeout and a bounded private output buffer. Empty or internally whitespace-separated output is rejected. Child-process errors, stdout, stderr, and causes never become public diagnostics. The Copilot exchange has a thirty-second timeout and returns only a fixed diagnostic and HTTP status on failure, not server response text or a potentially echoed token.

Pi stores the result using its existing renewable `oauth` credential shape with `authMethod: github-cli` and a fixed `refresh` source marker. Only the Copilot access token, expiry, and optional Enterprise hostname are retained; the GitHub token returned by the exchange helper is not persisted. Expiry re-runs gh for the same hostname before exchanging a replacement token. Legacy OAuth credentials, including those without an `authMethod`, keep their existing refresh path; pasted API keys retain their existing semantics.

The [independent-renewal decision](../bug-fix/2026-10-02-independent-oauth-renewal.md) continues to own scheduling, serialized persistence, metadata preservation, and separation from model discovery. CLI renewal uses those same Pi mechanisms without background timers, a second store, or a required catalog fetch. Failed commands or exchanges leave the saved credential available for retry. Helpers honor their supplied cancellation signal; Pi still owns the deadline and completion of an already locked refresh. No failure silently starts device authorization.

## Alternatives considered

- Treat the raw output of `gh auth token` as a Copilot API key: not selected because the tokens have different purposes and the API-key path does not exchange or renew them.
- Copy the GitHub CLI token into the ordinary OAuth refresh field: not selected because it duplicates a long-lived secret and stops tracking changes in gh's current credentials.
- Add the source selector to all shared-provider logins: not selected because Harness's page deliberately owns an explicit device-authorization flow and does not ask arbitrary selection questions.
- Replace GitHub OAuth entirely: not selected because CLI tokens are not guaranteed to be eligible for Copilot exchange; browser/device login remains an explicit alternative.

## Consequences

Pi users can reuse gh's current credentials without another plugin browser authorization. They need a working `gh` executable on Pi's inherited PATH and a suitable account/token for the chosen hostname. Switching gh's active account or token environment affects the next renewal; signing in again switches immediately. A 401/403 can reflect token eligibility, subscription access, or organization policy, and adding scopes is not a guaranteed remedy.

Synthetic-command and mocked-HTTP tests cover private execution, output validation, sanitized failures, cancellation, GitHub/Enterprise routing, token exchange, and metadata preservation. Registered-provider tests exercise source selection, extra Pi login options, concurrent renewal, persisted-token reuse, repeated expiry, and failed-renewal retry. The CLI suite is included in the isolated minimum-Pi test list. That runner accepts an explicit `--test-isolation=none` option for confined Windows environments that prohibit subprocess stdio pipes, while retaining subprocess isolation by default. No test invokes the real gh token command or establishes that a user's CLI token is accepted by GitHub.
