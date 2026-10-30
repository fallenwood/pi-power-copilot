# Agent Note: 增加原生 Oh My Pi provider 适配器

Status: implemented

[English](2026-10-30-omp-provider.md) | 中文

## Problem

Oh My Pi（OMP）18.14 使用按名称注册 provider、原生 OAuth 回调、规范化 thinking 元数据及基于 SQLite 的动态发现，而不是 Pi 1.x 的 provider 对象。通过 OMP 兼容垫片加载 Pi 扩展无法提供该契约。[Pi/Harness 架构](2026-10-22-dual-runtime-provider.zh.md)对这两个运行时仍然有效，但不代表其流式类型与 OMP 可互换。

## Decision

OMP 拥有独立的清单与扩展入口，Pi 清单及 Harness 导出保持不变。适配器共享与运行时无关的目录解析器、OAuth 兑换与续期、路由及上下文窗口校验，不共享 Pi provider 工厂。宿主包均为可选 peer，包括原有 pi-ai 包，因此仅安装 OMP 集成不需要 Pi 或 Harness SDK。开发将原生包固定为 18.14.0；声明的原生 peer 范围从 18.14 到 18.x。

OMP 的 provider 注册拥有三个带前缀的 API 处理器。它们针对相应原生协议重建发现的元数据，并委托 OMP 流式实现，不替换内置 API 或复制流转换。Copilot 请求头在请求时添加：OMP 缓存有意丢弃扩展拥有的请求头解析器，缺少可信回退时无法恢复这些行。不含请求头的目录行在重启后仍可使用。外层宿主分发拥有上下文编解码器及 provider 并发许可；内层分发禁用重复编解码及许可获取。重建原生协议元数据时保留选定的上下文及输出上限。

`power-copilot` 登录完全归属 OMP 当前凭据存储。认证方式提示提供设备 OAuth 或掩码 API-key 输入，后者返回普通字符串，使 OMP 保存常规 API-key 凭据。不复用或迁移内置 Copilot 登录，也不通过保存 token 或伪造 OAuth 到期时间来模仿 Pi 动态 GitHub CLI 来源语义。设备码适配为 OMP 授权通知。token 续期使用共享兑换流程，独立于模型发现。

OMP 的发现回调直接接收已保存的 OAuth `access`，绕过 `getApiKey` 且不提供 Enterprise 元数据。因此 OMP OAuth access 使用不透明的 `power-copilot-oauth-v1:` 前缀，后接包含 `token` 和可选 `enterpriseUrl` 的 JSON。发现解码两者；`getApiKey` 仅返回原始 token 用于请求。刷新解包并重新封装 access，保留 GitHub refresh grant 及真实到期时间。未封装的普通 API key 继续使用已有的 token 路由。该封装是 OMP 拥有的凭据数据，绝不是服务 bearer 或目录字段。无效封装产生固定诊断，不包含其内容。

OMP 发现仅查看未到期的 access，不生成凭据。`/power-copilot-refresh` 在请求实时发现前明确解析本 provider 的认证，使已到期 grant 与冷目录的组合能够恢复。常规发现保留 OMP 原生的 24 小时缓存策略。[上下文窗口决策](../feature/2026-10-17-custom-context-windows.zh.md)继续拥有共享边界及 Pi 可逆的原始缓存行为。OMP 从自身当前 agent 目录读取相同配置结构，但其原生缓存存储生效窗口。编辑需要重启及成功的实时重新发现；离线重启保留原先生效快照，即使覆盖值已删除。原生刷新失败时可回退到该快照，并显示发现诊断。

## Alternatives considered

- 在 OMP 中加载 Pi 已有 provider 或流式实现：不采用，因为 provider、transcript、thinking 和认证契约不同；兼容导入不会适配 Pi 1.x provider 对象。
- 为普通原生协议模型注册 provider/model 请求头：已通过真实原生 registry 验证，但不采用，因为带请求头的缓存行在重启后消失。provider 级默认 base URL 还会覆盖由凭据推导的 Enterprise 端点，因此动态模型各自携带端点。
- 跨运行时共享凭据，或将保存的 GitHub CLI token 作为 Pi 动态来源的替代：不采用，因为运行时所有权及重新解析来源必须明确；OMP 支持设备 OAuth 和粘贴 API key，不增加这些额外语义。

## Consequences

OMP 使用相同的服务发现目录和边界，同时保留原生流式处理、凭据所有权、profile、配置路径及缓存生命周期。带前缀的 API 标识和不透明 OAuth access 封装均为运行时专属格式。OMP 中的上下文窗口修改不可离线逆转；此例外不改变 Pi 已有原始缓存决策。更换账户后，明确刷新可避免依赖 OMP 按 provider 保存的旧目录。

与运行时无关的测试覆盖设备通知、重建适配器后的公共及 Enterprise 路由、原始 API-key 登录、不依赖发现的续期、取消、reasoning 转换、配置边界及不含秘密的诊断。Bun 原生测试使用真实扩展、registry、凭据存储、三种流式实现及分块 Unicode SSE 和用量，覆盖请求检查、单请求并发上限、到期 grant 恢复、Enterprise 凭据持久化，以及生效窗口缓存恢复与重新发现。隔离的编译版 OMP 18.14.0 CLI 冒烟运行在没有本地 SDK 依赖的情况下加载源码入口，并列出未认证的空目录；agent 目录辅助函数使用宿主提供的包根入口，而非编译版不可用的子路径。测试进程使用隔离目录及合成凭据；不验证真实授权或登录 UI 的实际显示。已有 Pi/Harness 测试及最低 Pi 版本脚本继续通过。

英文、中文及翻译元数据文件保持一致的章节、段落、列表及链接结构。
