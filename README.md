# LOFTER 阅读 · cortico-world-lofter

[![npm](https://img.shields.io/npm/v/cortico-world-lofter?label=npm&color=cb3837)](https://www.npmjs.com/package/cortico-world-lofter)
[![license](https://img.shields.io/npm/l/cortico-world-lofter?color=blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-43853d)](https://nodejs.org)
[![world api](https://img.shields.io/badge/cortico%20world%20api-6-8b5cf6)](https://github.com/Pal-AI-Lab/cortico)

给 Coopanion 接上 LOFTER 的**阅读**能力。

模型能按你说的去读一个博主的更新、一个标签下的新帖、单篇正文与配图；读到的正文和图片直链直接出现在对话里，不另外存一份。
它不点赞、不评论、不转发、不发私信。默认不落盘、不订阅、不定时联网 —— **你问，它才读**。

> LOFTER 没有对外的公开内容 API。
>
> 匿名访问 `www.lofter.com` 的每一个内容页都会 `302` 到 `/front/login`；`/front/discover` 只是个纯 SPA 壳。
> 正文真正的数据通道是站点自己的 DWR 端点 `/dwr/mobile/call/plaincall/<Bean>.<method>.dwr` —— **未登录时它回 200 + 空响应体**。
> 所以这个插件只做一件事：用你浏览器里的那份 Cookie，复刻同一个请求。

*Cortico World · `kind: world` · `api: 6` · `tags: internet / requires-key` · MIT · 141 项单测通过、契约校验通过*

[源码](https://github.com/suhong11300/cortico-world-lofter) · [问题反馈](https://github.com/suhong11300/cortico-world-lofter/issues) · [npm](https://www.npmjs.com/package/cortico-world-lofter)

## 目录

- [为什么需要它](#为什么需要它)
- [它怎么读 LOFTER](#它怎么读-lofter)
- [工作边界](#工作边界)
- [一次性设置：粘一次 Cookie](#一次性设置粘一次-cookie)
- [九个工具](#九个工具)
- [参数](#参数)
- [数据落在哪](#数据落在哪)
- [环境段长什么样](#环境段长什么样)
- [图形面板](#图形面板)
- [安装](#安装)
- [验证到哪一级](#验证到哪一级)
- [出网与落盘边界](#出网与落盘边界)
- [已知边界](#已知边界)
- [许可](#许可)

## 为什么需要它

LOFTER 的内容全在登录墙后面，而模型自己既没有账号，也拿不到你在浏览器里的登录态。

| 没有它 | 有它 |
| --- | --- |
| 想看某位博主的更新，只能自己开浏览器翻，再复制粘贴进对话 | 一句「看看某某最近写了什么」，模型自己去读 |
| 复制正文会丢段落、丢配图、丢发布时间 | 正文去标签后按段落给，配图给直链 |
| 让模型去搜 LOFTER，它只能编 | 走站内搜索，读不到就直说读不到 |
| Cookie 塞进环境变量或提交进仓库，泄漏没知觉 | Cookie 只在本机 `data/lofter/session.json`（`0600`），不进配置、不进日志 |

## 它怎么读 LOFTER

一次读取就是一次 `POST`，请求体是 DWR 规定的纯文本键值（`Content-Type: text/plain`）：

```text
callCount=1
page=/dwr/mobile/call/plaincall/BlogBean.getPostList.dwr
httpSessionId=
scriptSessionId=
c0-scriptName=BlogBean
c0-methodName=getPostList
c0-id=0
c0-param0=string:someone
c0-param1=number:0
batchId=0
```

响应不是 JSON，是一串 JS 赋值语句。插件按顶层分号切开、跳过引号与括号里的分号，再还原成对象：

```text
var s0={};
s0.posts[0].postId=101;
s0.posts[0].title="第一篇";
```

五个从实测里确认的事实，也是整个插件的行为依据：

| 现象 | 含义 | 插件怎么做 |
| --- | --- | --- |
| 未登录时 **200 + 空响应体**（不是 401） | 空体就是「没登录」，不是「没有内容」 | 空体直接判成登录过期，回执提示重新粘 Cookie，不冒充空列表 |
| Bean 名写错回 `SecurityException` 带 `No class by name: X`；Bean 名对回 `IllegalArgumentException` | 两者的差别让「名字对不对」**不需要 Cookie 也能验** | 端点表只写已实证存在的 Bean；不存在的那个（搜索）在回执里直说 |
| 方法名错 / 实参签名错 / 缺会话粘性字段 → **同一个 139 字节的 `IllegalArgumentException`** | 站点把三种错合并了，分不开 | 同一功能排几组候选逐个试，谁不报错用谁，命中后进程内记住 |
| 字段名不统一（`postId` / `id`、`digest` / `summary`…） | 站点自己也在演进 | 每个字段给一组候选键，命不中就丢这一条 |
| 一次请求扛不住高频 | 会被限速 | 每次调用之间有 `requestIntervalMs` 闸门（默认 1200ms） |

想自己复核 Bean 名，一条 `curl` 就够，**不需要 Cookie**：

```bash
curl -s -X POST 'https://www.lofter.com/dwr/mobile/call/plaincall/BlogBean.getPostList.dwr' \
  -H 'Content-Type: text/plain' \
  -H 'Referer: https://www.lofter.com/front/discover' \
  -H 'Origin: https://www.lofter.com' \
  --data-binary $'callCount=1\npage=/dwr/mobile/call/plaincall/BlogBean.getPostList.dwr\nhttpSessionId=\nscriptSessionId=\nc0-scriptName=BlogBean\nc0-methodName=getPostList\nc0-id=0\nc0-param0=string:x\nbatchId=0\n'
```

回 `No class by name` = 名字错了；回那个 139 字节的 `IllegalArgumentException` = 名字对了。
**`Referer` 不能省**：少了它站点对任何 Bean 都回空体，看起来像「全都不存在」。

## 工作边界

- **只读。** 四个 Bean 全是读接口，不发任何写动作：不点赞、不评论、不转发、不发帖、不发私信。
- **不自动联网。** 默认只在对话里被叫到时才请求；订阅（定时检查新帖）是关着的可选能力。
- **不落盘。** 图片默认只回直链，要存才存；存图目录自己指定。
- **不假装读过。** 没登录、Cookie 过期、上游 5xx，都在回执里说清楚是哪一种，不把错误包装成「没有内容」。
- **不动你的账号。** 不改昵称、不改关注、不改任何设置 —— 它连这些接口都没实现。

## 一次性设置：粘一次 Cookie

1. 浏览器登录 `www.lofter.com`。
2. 按 `F12` 打开开发者工具，切到 **Network**，筛选 `dwr`。
3. 在站内随便点开一篇文章或一个标签页，让列表里出现一条 `plaincall` 请求。
4. 点这条请求 → **Headers** → **Request Headers** → 找到 `Cookie:` 那一行，**整行值**复制（长这样：`__lfgw_sid=...; usertrack=...; LOFTER_SESS=...`）。
5. 回到 Coopanion → World 总览 →「LOFTER 阅读」→ 粘进 Cookie 框 → **保存并探活**。

带不带 `Cookie:` 前缀都行；换行会被压成 `; `。保存后会立刻用一次 `BlogBean.getPostList` 探活：

| 回执 | 意思 |
| --- | --- |
| `已保存,探活通过` | 能用 |
| `已保存,但探活没过:空响应…` | Cookie 存下了但**不是有效登录态**（粘错了、粘的是未登录的那份） |
| `已保存,但探活没过:HTTP 5xx` | 站点侧问题，过会儿再试 |
| `不像 Cookie…` | 值里没有任何 `key=value`，根本没存 |

**Cookie 会过期**（通常几个月，改密码或退出所有设备会立刻失效）。过期后模型会告诉你「登录态失效，去面板重新粘一次」，不会一直静默失败。

## 九个工具

| 名称 | 类型 | 参数 | 说明 |
| --- | --- | --- | --- |
| `lofter_login_status` | `read` | 无 | 报登录态与四个能力开关，纯本地，不联网 |
| `lofter_login_cookie` | `write` | `cookie` | 存 Cookie 并探活。也可以直接把 Cookie 打在对话里让模型存 |
| `lofter_blog_posts` | `read` | `blog` / `limit` | 某博主主页**首屏**能看到的帖子链接（没有翻页接口） |
| `lofter_tag_posts` | `read` | `tag` / `limit` | 标签维度。**实测接口层不可用**，只会回替代方案 |
| `lofter_search` | `read` | `keyword` / `limit` | 站内搜索。**实测接口层不可用**，只会回替代方案 |
| `lofter_post` | `read` | `postId` / `blog` | 读单篇文章页 HTML，抽出正文 + 配图直链 |
| `lofter_hot_posts` | `read` | `limit` / `offset` | 站内热门。**正文随列表一起回来**，一次就有全文 |
| `lofter_download` | `write` | `urls` | 把图存到本地。**需开存图** |
| `lofter_watch` | `write` | `action` / `target` / `kind` | 订阅表增删查与 `check`。除 `list` 外**需开订阅** |

四个可选能力全关时，只有「读单篇」「读博主主页」「读热门」可用 —— 这是默认形态：你给链接或给博主 ID，它去读。

## 参数

| 参数 | 默认 | 作用 |
| --- | :---: | --- |
| `worlds.lofter.enabled` | `false` | 挂载开关。扩展 World 默认关，装完要去激活 |
| `worlds.lofter.allowTagStream` | `false` | 允许按标签取流 |
| `worlds.lofter.allowSearch` | `false` | 允许站内搜索 |
| `worlds.lofter.allowDownload` | `false` | 允许把图片存到本地 |
| `worlds.lofter.allowWatch` | `false` | 允许订阅与 `check` |
| `worlds.lofter.downloadDir` | 空 | 存图目录；空时用 `<data>/lofter/images` |
| `worlds.lofter.requestIntervalMs` | `1200` | 两次上游请求之间的最小间隔（300–30000） |
| `worlds.lofter.maxImagesPerPost` | `30` | 单篇最多带回几张图 |
| `worlds.lofter.maxPostsPerCall` | `10` | 一次列表最多几条 |
| `worlds.lofter.maxBodyChars` | `8000` | 正文超过这个长度就截断（500–40000） |

除 `enabled` 外都带 `x-hot`，配置页改完即时生效，不用重启。

## 数据落在哪

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `<data>/lofter/session.json` | Cookie 与探活拿到的昵称、更新时间 | `0600`（仅本人可读） |
| `<data>/lofter/watch.json` | 订阅表（目标、类型、上次见到的最新一篇） | 普通 |
| `<data>/lofter/images/` | 存图目录，仅在开了存图并主动下载时产生 | 普通 |

`session.json` 是原子写（先写 `.tmp` 再 rename），面板底部直接显示它的绝对路径，想撤掉就删这个文件 —— 面板上「清除 Cookie」做的就是这件事。

**为什么 Cookie 不进 config.json？** Cortico 的配置 schema 没有 secret 类型；`ctx.storeSecret()` 又要求值里不含任何空白字符，而 Cookie 头天生带空格和分号。所以只能自己落盘到数据目录，并把权限压到仅本人可读。

## 环境段长什么样

`src/ENV_PROMPT.md` 三行：

```text
LOFTER 阅读:{{lofter.loggedIn}}{{lofter.nickname}}。
能用的动作:{{lofter.abilities | 只读单篇与博主主页}}。
别自己定时去联网;没登录就说没登录,不要凭印象讲 LOFTER 上有什么。
```

模板可覆盖，不用改包源码（升级不丢）：在部署目录放 `<botDir>/worlds/lofter/ENV_PROMPT.md`。
优先级：部署覆盖 > 包目录里的 `worlds/lofter/ENV_PROMPT.md` > 本包 `src/ENV_PROMPT.md`。

## 图形面板

入口：World 总览 →「LOFTER 阅读」→ 详情，或直接开 `/#/provider/world:lofter`。

页面上是这样几样：

1. **登录态摘要** —— 已登录时给昵称与脱敏指纹（`__lfgw_sid` 等 N 项），未登录时说清「现在只能问你要链接」。
2. **Cookie 输入框** —— 粘 Request Headers 里那一整行；保存成功后自动清空输入框。
3. **保存并探活 / 只探活 / 清除 Cookie** —— 保存会写入并立刻试一次读取；清除需要确认。
4. **能力只读展示** —— 四个开关与缺哪个开关的一句话提示；开关本身在配置页改。
5. **路径两行** —— 存图目录、登录态文件（带最后更新时间）。

面板走与其他 WebUI 面板同一条 RPC（body 必须是 `{"args":[…]}`，裸对象会静默走空参分支）：

```bash
# 读状态
curl -s -X POST "http://127.0.0.1:<web 端口>/api/webui/providers/world%3Alofter/panels/lofter/state" \
  -H "content-type: application/json" -d "{\"args\":[]}"

# 存 Cookie 并探活
curl -s -X POST "http://127.0.0.1:<web 端口>/api/webui/providers/world%3Alofter/panels/lofter/save-cookie" \
  -H "content-type: application/json" -d "{\"args\":[\"__lfgw_sid=...; LOFTER_SESS=...\"]}"

# 只探活 / 清除
curl -s -X POST "http://127.0.0.1:<web 端口>/api/webui/providers/world%3Alofter/panels/lofter/probe" -H "content-type: application/json" -d "{\"args\":[]}"
curl -s -X POST "http://127.0.0.1:<web 端口>/api/webui/providers/world%3Alofter/panels/lofter/clear-cookie" -H "content-type: application/json" -d "{\"args\":[]}"
```

## 安装

### 前置条件

| 项目 | 要求 |
| --- | --- |
| 宿主 | Coopanion 0.2.8+（Cortico 扩展 api 6） |
| Node | 22+（`corepack` 随 Node 提供，不用单独装 pnpm） |
| LOFTER | 一个能登录的账号（插件只借登录态读公开内容，不需要任何额外权限） |

扩展目录是 `<data>/extensions`，不是程序目录。以运行中实例 `GET /api/extensions` 返回的 `dir` 为准。

### 1 · 装进扩展目录

- **市场 / WebUI**：「扩展」页 → 搜 `cortico-world-lofter` 装，或手动安装选本机目录（link 方式，改源码重启生效）。
- **命令行**：`cd <扩展目录> && corepack pnpm add cortico-world-lofter`。

### 2 · 激活 World

部署 `config.json` 里 `worlds.lofter.enabled` 设成 `true`，或在 World 总览页点「激活」。**装 ≠ 启用。**

### 3 · 粘 Cookie 并自检

```bash
# 扩展是否被识别
curl -s "http://127.0.0.1:<web 端口>/api/extensions"

# 环境段是否进了系统前缀（找 ENVIRONMENT · lofter）
curl -s "http://127.0.0.1:<web 端口>/api/prompts/prefix"
```

## 验证到哪一级

分层给证，互不替代：

| 层 | 做了什么 | 能证明 | 不能证明 |
|---|---|---|---|
| 静态 | `tsc --noEmit` 干净；`vitest run` **138 项**全绿（`dwr` 18 + `html` 19 + `types` 22 + `session` 14 + `world` 33 + `adaptive` 16 + `security` 16） | 编解码、HTML 解析、字段归一、登录态存取、门禁与渲染自洽 | 站点接受这些请求 |
| 契约 | `describe.json` 由 `exportDescribe` 生成、`checkDescribe` 三项全 ok、0 warning | 包形状合 Cortico 规范 | 行为与观感 |
| 面板 | `node scripts/build-webui.mjs` 产出 `dist/webui.js` 4.3 KB | 浏览器产物能构建 | 面板在真宿主的渲染 |
| 运行时 | 2026-10-26 用真实 Cookie 跑通三条：热门 11 篇带全文、博主首屏 10 条链接、单篇正文与配图 | 请求四件套被站点接受、字段名对得上 | 宿主内面板交互未复测 |

```bash
corepack pnpm install
corepack pnpm build        # dist/webui.js
corepack pnpm typecheck
corepack pnpm test         # 138 项
corepack pnpm describe     # 重新生成 describe.json
corepack pnpm describe:check
```

`dist/webui.js` 进仓库也进 npm 包；改了 `src/webui/client.ts` 就 `pnpm build` 后一起提交。

**自检通过不等于验收。** 单测里的上游是假 fetch：它证明了「空响应被当成过期」「门禁关着不联网」「重名图片加序号」这些行为，不能证明 LOFTER 真的接受我们的请求体 —— 那一层已经用真实 Cookie 跑过了（见上表「运行时」那一行），但宿主里的面板点击仍未复测。

## 出网与落盘边界

插件手里有两样东西不能交给模型传进来的字符串去决定:一份用户的 LOFTER Cookie,和一个能往本机写文件的位置。所以每个请求在发出去之前都先过 `src/guard.ts` 的闸门。

| 闸门 | 规则 | 挡的是什么 |
| --- | --- | --- |
| 页面请求 | 只允许 `https://` + `lofter.com` 及其子域 | Cookie 被发到站外(传一个畸形博主名就能做到) |
| 存图请求 | 只允许 `http/https` + 图床白名单:`*.lf127.net`、`*.127.net`、`*.nosdn.127.net`、`*.nos.netease.com`、`*.netease.com` | 内网探测与云元数据读取(`127.0.0.1`、`169.254.169.254`) |
| 单张体积 | 32MB 上限:先看 `Content-Length`,读完再核一次实际字节 | 拿「存图」当内存放大器与写盘放大器 |
| 内容类型 | `Content-Type` 存在且不是 `image/*` 就拒 | 把网页、压缩包改名成 `.jpg` 落盘 |
| 博主名 | `^[a-z0-9][a-z0-9-]{0,62}$`,先归一化再校验 | 用 `@`、`/`、`.` 拼出畸形 URL 或越权域 |
| 文件名 | 只取 URL 末段,替换掉非法字符,重名加序号 | 路径穿越(`../`)与非法文件名 |

Cookie 的处置:只落 `<data>/lofter/session.json`(原子写 + `0600`),不进 `config.json`、不进环境变量;面板与工具回执只显示「前两个键名 + 字符数」这种指纹,不打印原文。

依赖面:**运行时零依赖**(`dependencies` 为空,只有 `devDependencies`)。`pnpm audit` 会报 14 条告警,全部落在 `vitest` / `vite` / `tinypool` / `esbuild` / `@vitest/mocker` 这条测试工具链上,触发条件都是「跑 vitest dev server、开 UI、处理不可信 mock」;`pnpm pack` 的清单里没有 `node_modules`,所以它们不进发布包,也不影响装了插件的机器。

已知残余风险:

- **Cookie 是明文落盘的。** `0600` 在 POSIX 上有效,在 Windows 上只影响只读位 —— 本机其它进程理论上读得到。要更严就得接系统密钥库,这个版本没做。
- **重定向跟随。** 上游若回 3xx 到别的域,`fetch` 默认会跟;严格讲白名单只校验了首跳。LOFTER 实测没这么做过。
- **不做写操作。** 点赞、评论、转发、发帖、私信都没实现,也没留 `eval` / `child_process` / 读环境变量的口子。

## 已知边界

- **站点只有两个能出数的 DWR 方法。** 2026-10-26 用真实 Cookie 逐条试过：`PostBean.getHotPosts(number,number)` 能出数（10 篇，每篇的 `content` 就是全文），`TagBean.getRandomRTPostList()` 能出首页推荐位。其余方法要么签名对不上（三错合一，见下条），要么进 DAO 就抛 `DBSupportRuntimeException`。所以列表能力只有「站内热门」，博主维度改走 HTML。
- **HTML 通道才是主力。** 单篇 `https://<blog>.lofter.com/post/<permalink>` 与博主首屏 `https://<blog>.lofter.com/` 都能直接 GET（带 Cookie）。permalink 形状是 `<8位hex>_<9位hex>`，纯数字拼 URL 一律 404 —— `lofter_post` 收到错形状时会回这句提示。
- **标签流与站内搜索确认不通。** `SearchBean` 连同 `SearchV2Bean` / `Search2Bean` / `BlogSearchBean` / `PostSearchBean` / `TagSearchBean` / `FindBean` / `QueryBean` 等二十多个候选名全回 `No class by name`（该 Bean 不存在）；标签维度能拿到的只有推荐位，不是按标签分页。这两个工具会直接说明并给替代路径，不会假装搜过。
- **`IllegalArgumentException` 是三错合一。** 「方法不存在 / 实参签名不对 / 缺 DWR 会话字段」回的是同一段 139 字节错误，无法区分，所以候选签名只能逐组试。命中后写进进程内的 `signatures`，下次先试它。校准入口集中在 `src/world.ts` 的 `DWR_ENDPOINTS`，改一张表即可。
- **Cookie 过期就得重粘。** 没有自动续期：插件不是浏览器，拿不到刷新凭据。
- **只读公开内容。** 私密文章、仅好友可见、需要付费的内容读不到；上游返回什么就是什么。
- **不保证拿到全文。** 站点给的是渲染过的片段时要靠正文候选键去猜；猜不中就是空正文，回执里会说明。
- **限速是硬编码下限。** `requestIntervalMs` 最低 300ms，再快容易触发风控；不建议改小。
- **图片直链会过期。** 网易系图床的直链带时效签名，隔天再点可能 403 —— 要长期留就开存图。
- **不做写操作。** 点赞、评论、转发、发帖、私信都没有实现，也没有留口子。
- **WebUI 端口浮动。** README 里的 `<web 端口>` 是占位；从实例启动日志或 `netstat` 找实际值。

## 许可

MIT，见 [LICENSE](LICENSE)。
