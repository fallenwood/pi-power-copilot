# Agent Note: 将 Harness provider 登录保留在 Models 设置中

Status: implemented

[English](2026-10-22-harness-model-provider-settings.md) | 中文

## Problem

Power Copilot 必须作为已配置 provider 出现在 Harness 的 Models 设置中，并让用户在该处授权。最初基于命令的 UX 将 provider 设置放进聊天，且依赖问题卡片，而模型页面本就拥有 provider 配置。缺少通用 OAuth 编辑器，并不能使命令成为正确的设置界面。本决策仅取代[双运行时决策](2026-10-22-dual-runtime-provider.zh.md)中基于命令的授权 UX；该说明继续拥有共享 provider 行为、streaming 复用、目录快照及独立凭据的理由。

仅在 `llm` 注册的路由没有可用的设置地址。Harness 设置镜像仅包含 volatile Config 字段，而 Models provider 编辑器支持经过整理的内置 namespace，不是任意 schema 生成的 provider 表单。因此，只声明目录项而不提供可编辑 namespace，不能让本插件的已配置卡片出现在页面中；仅提供 schema 也不会增加 OAuth 控件。

## Decision

[Harness 入口](../../../../src/harness.ts)为 `power-copilot` 声明 configurable-provider 目录行，以当前 Loader entry 的 `options.id` 作为 `settingsNs`，并使用空的 `settingsPath`。该地址表示本插件实例的整个配置，不是通用 `llm-pi-ai` provider 字典内的 profile。原生 Models section 拥有卡片、导航、添加 provider 机制及模型选择器；插件仅扩展卡片的 `settings.models.provider-card` 区域，以 Host 返回的真实设置 namespace 作为 key。

`contextWindows` 是 volatile Config 字段，因此设置镜像包含此 namespace，其根路径 provider 在授权前就已配置。该字段的自动插件设置表单仍可使用。运行时发现读取当前覆盖，设置变更使目录新鲜度失效，下一次刷新会发布应用新配置的模型快照。已有准备调用保留其捕获的元数据。`apiKeyEnv` 仍是普通静态插件配置，保留既有的 `POWER_COPILOT_API_KEY` 默认值；它有意不进入设置镜像。Models 页的通用凭据指示器只理解被引用的 API key，不理解已保存的 OAuth grant，因此卡片扩展拥有准确的登录及 fallback 凭据状态，而不是展示错误的缺少 key 指示器。

普通 Web Client 提供页面内 OAuth 和 API-key 控件、设备码说明、取消、退出及手动模型刷新。其精确的 `/api/power-copilot` bridge 使用既有 Connection 服务：GET 描述非敏感状态，POST 执行仅 owner 可用的操作。它既不暴露通用 remote service，也不代理任意凭据 key。OAuth 复用既有授权流程、交互映射及 session commit；API-key 输入也通过该流程提交。凭据保留在 Host 凭据存储中，token 不会出现在 bridge 响应、聊天或模型可见问题中。取消及销毁会停止待处理尝试；Client 仅轮询正在进行的授权尝试。启动元数据读取失败会有限重试，并随连接或拓扑变化恢复，而不会永久丢失 slot 注册。Host 写操作围栏覆盖取消以及完整的退出操作，包括记录删除和目录重载，避免另一标签页在前一 runner 结束后的空隙中启动未被发现的授权。

成功的凭据提交和删除使用既有 `credentials/record-updated` 通知。凭据引用变化保留 `credentials/reference-updated`，设置变化保留 `settings/document-updated`，显式目录或注册变化通过 `llm/adapters-updated` 使缓存失效。原生 Models store 及模型选择器已经订阅这些通知，并重新读取 Host 数据源。因此，扩展不访问其他插件的 store，不伪造新的模型列表事件，不轮询整个 Models 页面，也不改变已选模型。

[认证桥接层](../../../../src/harness-auth.ts)保留相同的 scoped 已保存记录、串行 OAuth 续期，以及已保存登录优先于引用 fallback 的规则。退出删除已保存登录，不删除独立配置的 fallback 凭据。Pi 保留自己的 `/login` 流程、配置目录及凭据。[使用指南](../../../../README.md)说明页面流程，以及动态上下文窗口设置和静态凭据引用配置的区别。

## Alternatives considered

- 保留 slash 命令及问题卡片：不采用，因为所需 provider 设置属于 Models 设置，provider-card 扩展可以提供该界面，而无需将授权移进聊天。
- 仅注册 configurable 目录行及标准 schema：不足，因为非 volatile Config 没有设置镜像 namespace，且原生 provider 编辑器不渲染任意 provider schema 或 OAuth 流程。
- 替换 Models 页面或冒用 `llm-pi-ai` namespace：不采用，因为现有页面已经拥有布局及 store 刷新，而其他 provider 家族的 schema 和身份不是本插件的配置契约。
- 将 OAuth grant 复制进 API-key 引用以满足原生徽标：不采用，因为这会重复秘密、错误表达可续期 OAuth 凭据，并改变独立凭据所有权契约。

## Consequences

Power Copilot 在登录前仍作为已配置的原生 provider 卡片显示，认证 UI 位于现有 Models section 内。通用编辑器不是本 provider 的登录界面。卡片自己的状态是其 OAuth 和 fallback 认证的权威状态；不将原生页面的通用 API-key 事实改作 grant 状态。

升级已经加载的纯 Host 包时，需要先重启现有 Host，再刷新页面。Harness 针对 Loader specifier 缓存 Client manifest 元数据，包括“没有 Client”的负向结论，直到重启才清除；重新安装链接不会清除此缓存。插件不会仅为绕过这一生命周期而改变包身份或替换核心服务。

Web 集成增加小型 Client 产物及仅 owner 可用的 HTTP bridge，不增加第二个应用、服务器、通用 remote API 或替代 streaming 实现。标准失效通知使原生选择器在授权和显式刷新后保持新鲜，而冻结的已准备调用保留原有目录视图。

自动化检查使用合成凭据及 mock provider 响应。这些检查并未人工验证真实 GitHub 浏览器授权或 Models 页面渲染效果；成功构建、注册或 HTTP fixture 不能证明其中任何一项。
