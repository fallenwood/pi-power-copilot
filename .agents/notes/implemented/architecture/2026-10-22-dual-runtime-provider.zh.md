# Agent Note: 在 Pi 与 Harness 间共享同一个 Power Copilot provider

Status: implemented

[English](2026-10-22-dual-runtime-provider.md) | 中文

## Problem

Power Copilot 原本是 Pi 扩展，但其动态目录、协议分发和认证也需要在 DeepSeek Harness 中工作。在 Harness 中加载 Pi 扩展入口，会将注册过程耦合到 Pi 运行时及其配置目录。另行维护流式实现会重复协议行为，并绕过 Harness 已有的上下文转换、附件处理和 replay 支持。隐式共享凭据也会模糊运行时的所有权。

## Decision

[共享 provider 工厂](../../../../src/provider.ts) 负责 Power Copilot 行为，不导入 Pi 的 coding-agent 运行时。[精简的 Pi 入口](../../../../src/index.ts) 选择 Pi 配置路径、注册 provider，并通过 Pi 的会话启动离线刷新恢复目录。`getModels()` 和 Pi 1.1 的 `getAllModels()` 都暴露已应用配置的目录，避免较新的读取接口绕过上下文窗口覆盖。已有的[请求头决策](../bug-fix/2026-09-23-copilot-model-request-headers.zh.md)和[续期决策](../bug-fix/2026-10-02-independent-oauth-renewal.zh.md)继续拥有这些行为及其理由。

[Harness 入口](../../../../src/harness.ts) 注册自己的 `power-copilot` 路由，并复用公开的 `PiAiAdapter`，不重新实现 streaming 或 replay。一个管理用的 `createModels()` 集合负责动态发现和认证。每次目录成功发布时，都会向 adapter 提供捕获模型列表的 provider 外观对象和新的 profiles map。该外观对象不暴露动态刷新，因此后续目录变化不能修改已准备调用所保留的模型视图。Harness 的附件与图像访问钩子仍连接到现有 adapter。

Harness 在检查目录新鲜度之前解析认证。目录的新鲜度间隔为五分钟，并发调用者共享一次刷新，每次刷新有三十秒超时。取消单个调用者只撤回该调用者，不取消其他调用者共享的工作；卸载插件会取消运行时工作。OAuth access token 续期本身不会改变账户与目录的身份标识。管理集合仅使用默认的进程内目录存储：Harness 不新增磁盘目录缓存，进程重启后需要重新发现模型。只有凭据通过 Harness 凭据服务持久化。

[Harness 认证桥接层](../../../../src/harness-auth.ts) 将已保存记录的访问限制在 `credentialKey("power-copilot", "power-copilot")`，其表示形式为 `power-copilot/power-copilot`。已保存登录优先；只有不存在记录时，才解析 Cordis `apiKeyEnv` 凭据引用，其默认值为 `POWER_COPILOT_API_KEY`，schema role 为 `credential-ref`。GitHub OAuth 和 API-key 授权使用 Harness 的通知、提示和凭据提交；后续 OAuth 刷新通过凭据服务的串行记录变更执行。运行时不读取 Pi 凭据文件或 provider 环境配置，不迁移 Pi 登录，不复用内置 GitHub Copilot 记录，也不探测 Pi 内置 token 变量。因此，虽然两个运行时使用相同的 provider 实现，其授权仍各自归属运行时。

[Models provider 设置决策](2026-10-22-harness-model-provider-settings.zh.md)仅取代本集成最初基于命令的授权 UX，不取代共享 provider、streaming、目录或凭据所有权的理由。Harness 缺少通用授权页面，并不能成为将本 provider 登录入口放在 Models 设置之外的理由：一个小型 provider-card Client 扩展补齐该界面。已注册授权流程、凭据提交、已保存登录优先级及独立 token 续期继续使用；不增加携带秘密的 composer 参数。

Harness 通过 Cordis 插件配置接收 `contextWindows`，不使用 Pi 配置目录。[上下文窗口决策](../feature/2026-10-17-custom-context-windows.zh.md)仍是边界、生效模型元数据及 Pi 原始缓存行为的权威说明。Harness 对自身配置应用相同校验；其原始目录和生效目录都保留在进程内。Models provider 设置集成增加动态配置读取及目录失效，同时保留已准备调用捕获的模型元数据。

[包清单](../../../../package.json) 保留 Pi 的源码扩展入口，并将生成的 JavaScript 导出为 Harness 插件入口。[构建配置](../../../../tsconfig.build.json) 生成 JavaScript，并改写相对 TypeScript 导入扩展名。Harness 集成包及 Pi 的 coding-agent 包是可选 peer，而 pi-ai 由两个运行时共同使用。Cordis bundle 包含中英文本地化元数据及原创 SVG 图标。Models provider 设置集成在现有 Web 应用内增加小型 Client 扩展，不改变 adapter，也不启动第二个应用。

开发使用 pi-ai 与 Pi coding agent 1.1，以及 Harness 0.2.1-rc.2 API。根级开发 override 将 coding agent 的 `pi-codemode` 依赖固定为 1.1.0，因为 1.4 移除了该 coding-agent 版本仍导入的 export。该 override 修复的是本仓库的开发依赖图，不是使用方的依赖约束，也不表示 peer 范围允许的每个版本都已验证。

## Alternatives considered

- 在 Harness 中直接加载 Pi 扩展：不采用，因为 `ExtensionAPI`、Pi 生命周期钩子及 Pi 配置目录不是 Harness 的 provider 注册和凭据接口。
- 仅用 YAML 声明通用 Harness 路由：不采用，因为其配置目录不能保留本 provider 的动态发现生命周期和逐模型协议选择。
- 在本包中复制 streaming、上下文转换和 replay：不采用，因为公开的 `PiAiAdapter` 已提供这些行为，包括附件集成。
- 持久化第二份 Harness 目录或导入现有 Pi 凭据：不采用，因为最小 Harness 集成只需要进程内目录及明确归属的凭据；额外磁盘格式和隐式迁移会增加生命周期与所有权责任。

## Consequences

Pi 保留原有扩展工作方式和持久化目录行为；Harness 获得独立授权的路由，使用相同的 provider 语义及 Harness 内置流式 adapter。Harness 重启后的目录是冷缓存，并在使用过程中定期查询服务。配置、凭据和目录生命周期仍各自归属运行时，而不是静默共享 Pi 状态。

集成依赖所述 Harness 版本提供的公开 `PiAiAdapter` 及 resolved-profile 契约。开发版本固定及生成的入口使本地构建可复现，不向使用方强加相同的传递依赖 override。合成凭据、测试端点及成功加载模块，不能证明已验证真实用户的设备登录、账户访问或 Plugin Manager 元数据的实际显示。

[最低 Pi 版本兼容性运行脚本](../../../../scripts/test-pi-minimum.mjs) 将当前源码及原有五个 Pi 测试文件复制到隔离的临时 ESM 项目，禁用安装脚本安装 pi-ai 与 Pi coding agent 0.87.1，并保留子进程失败状态。测试进程使用临时配置目录，不传入携带秘密的环境变量，并拒绝真实网络访问。原有 26 个测试在该最低版本上全部通过，无需应用开发依赖 override，也不改变工作区依赖。清理前会校验原临时目录的真实路径及前缀，再执行删除。
