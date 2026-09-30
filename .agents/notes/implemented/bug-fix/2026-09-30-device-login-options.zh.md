# Agent Note: 由 Pi 定义 OAuth 登录参数

Status: implemented

[English](2026-09-30-device-login-options.md) | 中文

## Problem

Pi 0.99.1 将 `LoginOptions` 对象作为 provider OAuth 登录的第二个参数传入。Power Copilot 将该参数用于仅供测试的设备登录函数，因此 `/login` 把选项对象当作函数调用，在请求 GitHub 设备码之前就报出 `deviceCodeLogin is not a function`。开发环境使用的 0.87.1 SDK 只为交互参数声明类型，因此这个存在冲突的可选参数未被发现。

## Decision

注册的 OAuth 登录适配器只接收交互对象，并直接调用真实的 GitHub OAuth 实现。该流程不需要应用安装 ID，因此忽略 Pi 传入的额外登录上下文。回归测试向注册的 provider 传入登录选项，并使用受控网络响应执行设备授权和凭据转换，而不是替换登录实现。

## Alternatives considered

- 在注册时包装回调，只转发交互对象：未采用，因为这会在导出的适配器上保留存在冲突的测试专用参数，只在一个调用点掩盖契约不匹配。
- 将函数注入移到另一个参数：未采用，因为 provider 回调参数由 Pi 定义；控制网络响应即可覆盖真实的认证路径，无须扩展该回调 API。

## Consequences

登录同时适用于 0.87.1 的单参数契约和 0.99.1 带选项的契约，无须改变 peer dependency 的最低版本。GitHub OAuth 凭据、刷新行为和设备码通知保留现有格式。测试不再依赖 provider 登录适配器中的函数注入参数。
