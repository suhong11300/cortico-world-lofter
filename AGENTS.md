# 包内约定

这是 `cortico-world-lofter` 的仓库，不是 Cortico 本体。改这个包时按下面的约定来。

## 结构

- `src/definition.ts`：World 定义（id `lofter`、默认值、`create`、自描述）。`describe` 里的工具必须覆盖实例可能返回的全部。
- `src/world.ts`：`LofterWorld` 与 `LOFTER_TOOL_DECLS`。**`DWR_ENDPOINTS` 是唯一需要校准上游方法名的地方** —— 站点改接口时只改这张表。
- `src/api.ts`：一次请求的生命周期（头、限速、错误分类）。空响应体 → `LofterAuthError`，这是站点行为，不是 bug。
- `src/dwr.ts`：纯函数，请求体拼装与响应还原。不要在这里引入 IO。
- `src/session.ts`：登录态读写，原子写 + `0600`。
- `src/config.ts`：配置段与 JSON Schema。每条 schema 路径都要落在 `worlds.lofter.` 下，且 `LOFTER_DEFAULTS` 里有同名默认值。
- `src/ENV_PROMPT.md`：环境段模板。占位符只允许 `[\w.]`，所以变量是 `lofter.*`。
- `describe.json`：由 `scripts/describe.mts` 生成，不手写。

## 改动后必须做的验证

```bash
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
corepack pnpm describe:check
```

新增或改名工具时，`describe.json` 必须重新生成，否则 `describe:check` 会挂。

## 不要做的事

- **不要打印 Cookie。** 日志、错误消息、回执里都不出现原文；要展示就用 `maskCookie()`。
- **不要在没有真实 Cookie 的情况下标注「已验证」。** README 的「验证到哪一级」必须如实写当前层级。
- **不要为「读不到」编内容。** 空结果与登录过期是两件事，回执必须区分。
- **不要绕过门禁。** 四个开关的检查放在 handler 第一行，先于任何网络调用；`lofter_watch` 的 `list` 是唯一例外（纯本地）。
- **不要加写操作。** 点赞、评论、转发、发帖、私信都不在这个包的范围内。
- **不要在浏览器侧引入框架运行时依赖。** `src/webui/client.ts` 只允许 `import type`；构建报 `Could not resolve cortico/…` 说明有一处漏网，去本地化，不要配 alias 放行。
