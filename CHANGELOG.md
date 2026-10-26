## 0.1.1

市场卡片补上配图与显示名，标签按功能重划；抓取逻辑与 0.1.0 完全一致。

- **图标**：新增 `icon.svg`（光圈 + 正文行 + 右上光点），写进 `cortico.icon` 并加进 `files`。
- **标签重划**：`external-setup` / `experimental` → `internet` + `requires-key`。读站点内容算 `internet`；必须用你自己的 LOFTER 登录态算 `requires-key`。没有上 `unofficial-api`：按词表定义，仅复用登录会话去读「用户在浏览器里本来就看得见的内容」不算。
- **中英双名**：补 `cortico.locales.zh/en`（LOFTER 阅读 / LOFTER Reader）。

## 0.1.0

首个版本：**只读**。用本机存的 Cookie 复刻站点自己的请求，把博文与配图带回对话。

### 能读什么（2026-10-27 用真实 Cookie 定案）

- **九个工具**：`lofter_login_status` / `lofter_login_cookie` / `lofter_blog_posts` / `lofter_tag_posts` / `lofter_search` / `lofter_post` / `lofter_hot_posts` / `lofter_download` / `lofter_watch`。
- **只有两个 DWR 方法能出数**：`PostBean.getHotPosts(number,number)`（10 篇，每篇的 `content` 就是全文，143 KB 一次拿完）与 `TagBean.getRandomRTPostList()`（首页推荐位）。其余方法要么签名对不上，要么进 DAO 就抛 `DBSupportRuntimeException`。
- **博主维度改走 HTML**：`https://<blog>.lofter.com/` 抓首屏链接，`https://<blog>.lofter.com/post/<permalink>` 抓单篇（正文在 `div.content`，配图在 `*.lf127.net/img/`）。permalink 形状是 `<8位hex>_<9位hex>`，纯数字拼 URL 一律 404。
- **标签流与站内搜索确认不通**：`SearchBean` 连同 `SearchV2Bean` / `Search2Bean` / `BlogSearchBean` / `PostSearchBean` / `TagSearchBean` / `FindBean` / `QueryBean` 等二十多个候选名全回 `No class by name`。这两个工具直接说明并给替代路径，不假装搜过。

### 行为约定

- **默认纯被动**：标签流、站内搜索、存图、订阅四个开关默认全关；开与不开，门禁都在 handler 里先拦一次，不联网。
- **Cookie 只存本机**：`<data>/lofter/session.json`，原子写 + `0600`。不进 `config.json`、不进环境变量、不进日志（面板只显示脱敏指纹）。之所以不塞进配置段：宿主的 `storeSecret` 要求值无空白，而 Cookie 头天然带空格分号。
- **空响应判过期**：未登录时上游回 200 + 空体，插件把它识别成「登录态失效」而不是「没有内容」，避免模型拿空结果编故事。
- **限速**：每次上游请求之间有 `requestIntervalMs` 闸门，默认 1200ms；HTML 抓取与 DWR 调用共用同一道闸。
- **不做写操作**：点赞、评论、转发、发帖、私信都没有实现。

### 出网与落盘闸门(`src/guard.ts`)

- **页面请求只发 `lofter.com`**：`assertLofterPageUrl` 校验 `https:` 与域名后缀，畸形博主名拼不出站外地址，Cookie 不会跟着请求跑到别的域。
- **存图只连图床白名单**：`assertImageUrl` 要求 `http/https` 且主机命中 `*.lf127.net` / `*.127.net` / `*.nosdn.127.net` / `*.nos.netease.com` / `*.netease.com`；`127.0.0.1`、`169.254.169.254`、`file:` 在发请求前就被拒，连状态码都拿不到，也就做不了内网探测。
- **单张 32MB 上限 + `Content-Type` 必须 `image/*`**：先看 `Content-Length` 早退，读完再核实际字节；非图片一律拒，不落盘。
- **博主名形状校验**：`^[a-z0-9][a-z0-9-]{0,62}$`；`@evil.com`、`a b`、`someone.evil.com` 直接回执，不发请求。
- **测试链告警不进发布包**：`pnpm audit` 的 14 条全部落在 `vitest` / `vite` / `tinypool` / `esbuild` / `@vitest/mocker`，运行时零依赖，`pnpm pack` 清单里没有 `node_modules`。

### 实现要点

- **DWR 编解码自实现**：请求体按 DWR 规定拼 `c0-paramN=string:|number:|`，响应按顶层分号切语句后还原成对象（含 `s0.a.b[0]=` 形式的数组下标）。请求必须带 `Referer`，缺了会一律回 200 空体。
- **响应要按 s 编号取，不能取第一个**：站点返回的第一个变量常是 `s16={}` 空壳，取第一个顶层值就拿到空对象（实测热门接口共 141 个顶层值、11 篇带 permalink）。`callValues` 按编号数字排序返回全部值，调用方自己挑。
- **字段归一按真机数据校准**：热门对象只有 `permalink` 没有 `postId`；完整地址在 `blogPageUrl`；`firstImageUrl` / `photoLinks` 是**字符串化 JSON**（要先 `JSON.parse` 再取 URL）；`blogName` 字段缺失、且首页给的常常是中文昵称不是域名。
- **实参签名自适应**：站点把「方法名错 / 参数不对 / 缺会话字段」合并成同一个 139 字节 `IllegalArgumentException`，所以每个端点排一组候选，运行时逐个试，命中后本进程内记住并打日志。
- **面板**：粘 Cookie、保存并探活、只探活、清除（需确认）、四个能力只读展示、存图目录与登录态路径两行。
- **HTML 解析零依赖**：`src/html.ts` 手写实体解码、嵌套 div 配平、标题去博主名后缀（站点把 `<文章标题>-<博主名>` 拼进 `<title>`，而页面里的 `<h1>` 放的是博主名不是标题）、配图筛掉 `thumbnail=16y16` 这类头像小图。

### 验证

- 静态：`tsc --noEmit` 干净；`vitest run` **138 项**全绿（`dwr` 18 + `html` 19 + `types` 22 + `session` 14 + `world` 33 + `adaptive` 16 + `security` 16）。
- 契约：`describe.json` 9 个工具、`checkDescribe` 三项全 ok、0 warning。
- 真机：热门 11 篇带全文、`road11` 首屏 10 条链接、单篇正文 `Set sail.` 与 4 张配图，请求四件套被站点接受。

### 已知未完成

- 宿主内的面板点击未复测（构建产物与 RPC 形状都对，但没在真界面点过）。
- 博主维度只有首屏：站点没有公开的「按博主翻页」接口，要更多只能一篇篇给链接。
- Cookie 过期需重粘，没有自动续期。
