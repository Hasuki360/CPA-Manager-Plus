# 前端架构重构约定

## 目标

前端按应用壳、共享能力、后端资源、业务功能和路由页面分层，避免继续把请求编排、领域规则和展示状态堆在单个页面文件中。

## 目录职责

- `apps/web/src/app`: 应用启动、路由装配、全局生命周期副作用。
- `apps/web/src/shared`: 通用 UI、hooks、API transport、storage、format 等不属于具体业务域的能力。
- `apps/web/src/entities`: 后端资源和领域对象，例如 `usageService`、`config`、`provider`、`authFile`。
- `apps/web/src/features`: 可独立演进的业务能力，例如 `dashboard`、`monitoring`、`aiProviders`、`authFiles`。
- `apps/web/src/pages`: 路由级薄壳，只做页面挂载和少量路由适配。

## 依赖方向

- `app` 可以组合 `pages`、`components`、`stores`。
- `pages` 可以引用 `features`。
- `features` 可以引用 `entities`、`components`、`hooks`、`utils`、`stores`。
- `entities` 不引用页面和 UI 组件。
- `shared` 不引用 `features`、`pages`、业务 store。

## 迁移原则

- 先迁移一个垂直切片，再推广到复杂页面。
- 页面先变薄，业务逻辑进 feature，资源访问进 entity。
- API 地址解析、错误适配、兼容旧服务标识等逻辑只能有一个入口。
- 不在迁移中做无关 UI 重设计。
- 每阶段必须通过类型检查、相关单测和构建验证。

## 当前迁移状态

- `dashboard`: 已迁入 `apps/web/src/features/dashboard`，`apps/web/src/pages/DashboardPage.tsx` 保留路由薄壳。
- `aiProviders`: 列表页、编辑页、共享样式和路由参数工具已迁入 `apps/web/src/features/aiProviders`。
- `authFiles`: 主页面、OAuth 子页面、共享样式和测试已迁入 `apps/web/src/features/authFiles`。
- `monitoring`: 监控中心、Codex 巡检页面和共享样式已迁入 `apps/web/src/features/monitoring`。
- `quota`: 页面和共享样式已迁入 `apps/web/src/features/quota`。
- `config`: 配置页面已迁入 `apps/web/src/features/config`，配置 section 解析已迁入 `apps/web/src/entities/config`。
- `login`: 登录页面、登录模式解析和测试已迁入 `apps/web/src/features/login`。
- `logs`: 日志页面、日志解析和滚动筛选 hooks 已迁入 `apps/web/src/features/logs`。
- `oauth`: OAuth 工具页面已迁入 `apps/web/src/features/oauth`。
- `system`: 系统信息页面已迁入 `apps/web/src/features/system`。
- `pages`: 已清理未引用的占位页和旧登录样式，当前仅保留路由薄壳。
