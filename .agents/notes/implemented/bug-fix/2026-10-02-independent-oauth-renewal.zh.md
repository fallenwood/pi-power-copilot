# Agent Note: 将 Copilot 令牌续期与模型发现解耦

Status: implemented

[English](2026-10-02-independent-oauth-renewal.md) | 中文

## Problem

Copilot 访问令牌的有效期很短，而作为刷新凭据保存的 GitHub OAuth 令牌可以实现自动续期。Power Copilot 成功交换 GitHub 令牌后，仍要求完整获取并解析 `/models`，才返回续期后的凭据。因此，模型目录服务不可用、模型条目格式错误或刷新超时都会变成 OAuth 失败，阻止 Pi 持久化有效的替代令牌。即使 GitHub 凭据仍然可用，也可能看起来需要手动进行设备登录。

## Decision

OAuth 续期只执行 Copilot 令牌交换，并保留现有凭据元数据，包括 GitHub 刷新令牌及此前的模型可用性快照。模型目录更新由 provider 独立的模型发现钩子负责。刷新调度、凭据锁和持久化由 Pi 管理；扩展不增加定时器或并行凭据存储，并保留现有的到期安全余量。

回归测试通过 Pi 的模型运行时和注册的 provider 验证自动续期，覆盖并发请求、新运行时复用、重复到期、交换失败后重试以及取消。企业版续期保留域名路由和元数据。文档区分可以续期的 GitHub OAuth 凭据与粘贴的 API key，后者不包含刷新凭据。

## Alternatives considered

- 在续期时尽力获取 `/models`：不采用，因为即使吞掉目录错误，获取操作仍会消耗共享的刷新时限并占用 Pi 的凭据锁。模型发现已经有独立且受支持的钩子。

## Consequences

成功的交换立即返回给 Pi 进行持久化，不依赖模型目录是否可用。令牌交换错误和取消仍会向上传递；交换失败时，存储的凭据仍可用于重试。被撤销或无效的 GitHub 凭据仍需要重新登录，粘贴的 API key 仍不能自动续期。凭据格式保持兼容，但续期不再更新此前的 `availableModelIds` 快照；最新的模型元数据改由 provider 的模型发现提供。
