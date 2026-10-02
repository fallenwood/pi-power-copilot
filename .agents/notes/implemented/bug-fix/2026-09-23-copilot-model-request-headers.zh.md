# Agent Note: 为模型请求附加 Copilot 请求头和 Bearer 认证

Status: implemented

[English](2026-09-23-copilot-model-request-headers.md) | 中文

## 问题

Power Copilot 在 provider 上声明 IDE 身份请求头，但 Pi 的 API adapter 从每个模型组装聊天请求头。因此，动态发现的模型发送聊天请求时缺少 `Editor-Version`，导致 Copilot API 拒绝请求。Pi 的通用 Anthropic adapter 还会把 API-key 凭据作为 `x-api-key` 发送；Copilot 的 Claude `/messages` 端点则要求 Bearer `Authorization` 请求头。

## 决策

每个动态发现的 Power Copilot 模型都携带完整的 Copilot 请求头集合，包括编辑器身份和 GitHub API 版本。同一共享请求头定义仍保留在 provider 上，并用于模型发现。
只有 Anthropic Messages 分发路径会把当前请求的凭据转为 Bearer 请求头，并清除通用 Anthropic API key。其他 adapter 保持原有认证行为。凭据不会写入静态模型请求头。

## 考虑过的替代方案

- 仅依赖 provider 级请求头：因当前 Pi 请求路径不会将其传播到 API adapter 而被否决。
- 分别修改每个 API adapter 调用：因模型请求头是受支持的跨 adapter 机制，并且可以避免重复分发逻辑而被否决。
- 把 Copilot 令牌写入模型请求头：因模型可能比刷新后的凭据存活更久，导致使用过期令牌而被否决。
- 将 Power Copilot 模型标识为内置 `github-copilot` provider：因这会改变 provider 身份并触发无关的内置行为而被否决。

## 后果

OpenAI Responses、OpenAI Completions 和 Anthropic Messages 请求都会一致地收到所需的 IDE 身份。Claude 请求使用当前凭据作为 Bearer 认证，且不发送 `x-api-key` 请求头。Copilot 客户端身份或 API 版本变更时，必须更新共享请求头定义。
