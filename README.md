# Pi Power Copilot Provider

This Pi extension registers a `power-copilot` provider and discovers its models from the Copilot-compatible `GET /models` endpoint. Model IDs and capabilities are not embedded in the extension.

## Configuration

Use `/login` and select **Power Copilot**, then choose **GitHub OAuth** or **API key**. API-key login uses Pi's standard secret-entry flow. OAuth and API-key credentials are stored under the separate `power-copilot` provider and do not read or reuse the built-in `github-copilot` credential.

The API host is determined during `/login`. When `enterpriseUrl` is set, Copilot API requests use `https://api.enterprise.githubcopilot.com`; otherwise they use `https://api.githubcopilot.com`.

Load the extension directly during development:

```sh
pi --extension ./src/index.ts
```

The OAuth flow requests a device code, exchanges the GitHub OAuth token for a short-lived Copilot token, and refreshes that token as needed. Both auth methods retrieve the account's model catalog. The `/models` response must contain a `data` array in the Copilot model format. Chat models need `id`, `name`, `capabilities.limits.max_context_window_tokens`, and `capabilities.limits.max_output_tokens`. `capabilities.supports.vision` and `capabilities.supports.reasoning_effort` configure Pi's model capabilities. Models marked `model_picker_enabled: false`, non-chat models, and models without a supported `/responses`, `/chat/completions`, or `/messages` endpoint are omitted.

For each model, the extension prefers the Responses API, then Anthropic Messages, then Chat Completions. It uses Pi's built-in streaming implementations and does not log tokens or provider response bodies.

## Development

```sh
npm install
npm test
npm run typecheck
```
