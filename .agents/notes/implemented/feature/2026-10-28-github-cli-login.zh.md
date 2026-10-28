# Agent Note: 在 Pi Power Copilot 中使用 GitHub CLI 凭据

Status: implemented

[English](2026-10-28-github-cli-login.md) | 中文

**已部分取代：**[GitHub CLI token 直接认证](../bug-fix/2026-10-28-direct-github-cli-token.zh.md)取代本说明中强制兑换的假设、OAuth 来源选择器、CLI 凭据格式及按到期时间获取 token 的行为。下文这些部分记录原有决策，不代表当前 CLI 行为。固定参数的私有 runner、取消、有界输出、错误脱敏、不复制长期 token 及运行时隔离的理由仍以本说明为准。

## Problem

已经通过 GitHub CLI 登录的 Pi 用户需要在不再次进行浏览器或设备授权的情况下登录 Power Copilot。将 `!gh auth token` 配置为 API key 只会提供 GitHub token，而 Power Copilot 的模型发现和请求需要兑换后的 Copilot token。将 CLI token 复制到另一个凭据存储还会重复保存长期秘密，并使续期与 gh 的当前凭据脱节。

## Decision

Pi 在可自动续期的登录选项中显式启用 GitHub 来源选择器，可选择既有的 GitHub OAuth 设备流程或 GitHub CLI。共享 provider 默认保留既有设备流程，因此依据[双运行时决策](../architecture/2026-10-22-dual-runtime-provider.zh.md)，Harness 的 Models 页面、授权提示及凭据所有权均保持不变。

CLI 流程执行固定的 `gh` 程序，将 `auth token --hostname <normalized-hostname>` 作为独立参数传入，不使用 shell，也不提供任意命令配置。命令不交互、支持取消，具有十秒超时和有界的私有输出缓冲区。空输出或内部包含空白分隔的输出会被拒绝。子进程错误、stdout、stderr 和 cause 不会进入公开诊断。Copilot 兑换具有三十秒超时，失败时只返回固定诊断及 HTTP 状态，不返回服务端响应文字或可能被回显的 token。

Pi 使用现有可续期的 `oauth` 凭据结构保存结果，其中 `authMethod: github-cli`，`refresh` 为固定的来源标记。只保留 Copilot access token、到期时间及可选的 Enterprise 域名；兑换辅助函数返回的 GitHub token 不会被持久化。到期时对同一域名重新运行 gh，再兑换替代 token。旧 OAuth 凭据，包括没有 `authMethod` 的凭据，继续使用原有刷新路径；粘贴的 API key 保持原有语义。

[独立续期决策](../bug-fix/2026-10-02-independent-oauth-renewal.zh.md)继续拥有调度、串行持久化、元数据保留及与模型发现分离的理由。CLI 续期复用这些 Pi 机制，不增加后台定时器、第二份存储或必需的目录获取。命令或兑换失败会保留已保存凭据以便重试。辅助函数遵循传入的取消信号；Pi 仍负责已加锁续期的时限与完成。失败绝不会静默启动设备授权。

## Alternatives considered

- 将 `gh auth token` 的原始输出当作 Copilot API key：不采用，因为两种 token 用途不同，API-key 路径不会兑换或续期。
- 将 GitHub CLI token 复制到普通 OAuth refresh 字段：不采用，因为这会重复保存长期秘密，并停止跟踪 gh 当前凭据的变化。
- 为所有共享 provider 登录加入来源选择器：不采用，因为 Harness 页面有意拥有明确的设备授权流程，不询问任意选择问题。
- 完全替换 GitHub OAuth：不采用，因为不能保证 CLI token 有资格兑换 Copilot；浏览器或设备登录仍保留为显式备选方式。

## Consequences

Pi 用户可以复用 gh 当前凭据，无需再为插件进行浏览器授权。用户需要在 Pi 继承的 PATH 中提供可用的 `gh` 程序，并为所选域名提供合适的账户及 token。切换 gh 的活动账户或 token 环境会影响下次续期；重新登录可立即切换。401/403 可能反映 token 资格、订阅访问或组织策略问题，增加 scope 并不能保证解决。

合成命令与 mock HTTP 测试覆盖私有执行、输出校验、错误脱敏、取消、GitHub/Enterprise 路由、token 兑换及元数据保留。注册 provider 的测试验证来源选择、额外 Pi 登录参数、并发续期、已持久化 token 复用、重复到期及续期失败后重试。CLI 测试套件已纳入隔离的最低 Pi 版本测试清单。该脚本为禁止子进程 stdio 管道的受限 Windows 环境提供显式的 `--test-isolation=none` 选项，默认仍使用子进程隔离。测试不执行真实的 gh token 命令，也不能证明用户的 CLI token 会被 GitHub 接受。
