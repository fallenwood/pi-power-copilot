# Agent Note: 使用 GitHub CLI 原始 token 认证而不兑换

Status: implemented

[English](2026-10-28-direct-github-cli-token.md) | 中文

## Problem

用户报告，`gh auth token` 的原始输出已能作为 Harness 中同一个插件的 API key 使用，而新增的 `/copilot_internal/v2/token` 兑换返回 403。兑换接口拒绝请求，并不能证明原始 token 无法直接认证 Copilot 请求。强制兑换为已经可用的 API-key 路径增加了一个失败步骤。

本决策部分取代[最初的 CLI 登录决策](../feature/2026-10-28-github-cli-login.zh.md)：替换其强制兑换假设、位于 OAuth 登录中的选择器、OAuth 形状的 CLI 存储，以及按到期时间获取 token 的行为。私有固定参数执行、取消、有界输出、错误脱敏、不复制长期 token 及运行时隔离的理由仍由该说明拥有。

## Decision

Pi 在 API-key 登录中提供 GitHub CLI，与 Paste API key 并列。CLI 登录规范化域名，运行 gh 验证 token 可用性，丢弃输出，并保存不含 `key` 的 `api_key` 凭据。只存储 `env.POWER_COPILOT_AUTH_SOURCE: github-cli` 和 `env.POWER_COPILOT_GITHUB_HOST`。该登录辅助函数不进行设备授权、内部 token 兑换或目录请求。

每次解析认证都会私下重新运行 gh，将当前原始输出作为请求 API key 返回。既有模型发现和三种流式协议以 Bearer 认证发送该值，沿用既有 proxy/Enterprise base-URL 路由。CLI 可用性检查只读取精确匹配的来源标记，不执行命令。显式 `key`（包括空字符串）优先于标记，保留运行时 key 覆盖。解析失败时不改变来源配置，供下次重试，不缓存失败结果或过期 token。

已有 `authMethod: github-cli` 的 OAuth 记录仍可读取。即使存储记录尚未到期，其认证和模型发现路径也会动态获取 gh 原始输出。若旧记录需要刷新，兼容辅助函数只验证 gh，清空 `access`，将 `refresh` 替换为固定 CLI 标记，并把 `expires` 设为 `Number.MAX_SAFE_INTEGER`，同时保留 Enterprise 和其他元数据。这不表示 token 永久有效：认证仍每次读取 gh。重新登录会将该登录迁移为新的 API-key 来源表示。

共享 provider 默认不启用 CLI 选择器和解析，因此 Harness 原有浏览器授权及粘贴 API-key 路径保持不变。Pi 原有浏览器 OAuth 流程也保持不变，包括独立的 token 兑换和续期。此次 CLI 纠正不引入静默回退，也不在运行时之间转移凭据。

## Alternatives considered

- 保留强制 Copilot token 兑换：不采用，因为用户观察到该接口返回 403，而同一原始 token 的直接使用成功。
- 将 gh 原始输出放入 OAuth `access` 并伪造到期时间：不采用，因为这会把外部 API-key 来源错误表示为 OAuth grant，并将长期秘密复制进存储。
- 使用 Pi 通用的 `!gh auth token` key 配置：本集成不采用，因为它使用通用 shell 执行和进程生命周期输出缓存；已有私有固定参数 runner 支持实时解析而没有这些语义。
- 移除浏览器 OAuth：不采用，因为直接 CLI 凭据与浏览器授权是不同的显式选项；修正 CLI 语义不要求删除已有流程。

## Consequences

CLI 登录不再依赖 token 兑换接口接受 CLI 应用的 token。gh 中账户或 token 环境的变化影响下次认证解析，而不是虚构的 Copilot 到期时间。Pi 继承的 PATH 中仍需提供 `gh`，直接服务请求仍执行账户访问和组织策略检查。直接 token 可用的报告来自用户；自动化检查不读取真实凭据，也不独立证明该用户 token 被接受。

合成命令测试保留先前 runner 的安全覆盖，并断言 CLI 登录、解析及兼容刷新不会进行设备、兑换或目录 fetch。测试覆盖精确标记匹配、显式 key 优先、重新读取原始 token、GitHub/Enterprise/proxy 路由、不复制 token 的存储、元数据保留、取消，以及失败后重试。注册 provider 的测试另行覆盖实际发现和协议分派。英文、中文及翻译元数据文件保持章节、段落、列表和链接结构一致。
