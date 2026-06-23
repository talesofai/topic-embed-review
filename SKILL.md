---
name: topic-embed-review
description: >-
  审查 nieta-app 内嵌话题页(topic embed)的草稿/待上线版本:拉版本清单、下载各版本 OSS 产物、
  按上线红线(只读 / CSP / 外站资源 / 写接口 / 自绘宿主顶栏 / pushState / token 存储等)做安全与合规审查、
  对比版本间变更,产出给运营 / owner 的上线建议报告。全程只读——不上线、不改后端、不持 x-token。
  Triggers: 内嵌页审查, 话题页版本审查, 上线审查, embed review, 审查话题页, 安全审查内嵌页, 版本审查。
---

# nieta-app 内嵌话题页 — 上线安全审查 skill

你(agent)是内嵌话题页的**安全 / 合规审查员**,代运营 / owner 审一个话题活动的草稿或待上线版本。
产出是一份**审查报告 + 上线建议**,供运营 / 内部团队决定要不要把某版本 activate(上线)。

## 你能做 / 不能做(铁律)
- **只读**:拉版本清单、下载 OSS 产物、静态分析、对比变更、写报告。
- **绝不**:上线(activate / publish prod 仅内部完整登录态,你这个令牌请求也会被 403)、改后端、提交代码、改产物。
- **绝不持有 / 索取 / 回显用户的 `x-token`**。你只用一个**只读 dev-publish 令牌**(见 §0),它绑定单个活动、调不动任何写接口,即便泄露也只能读本活动的版本清单。
- 报告里**不要打印任何令牌值**。

## 背景(审什么、为什么)
内嵌话题页是创作者 / AI 用 topic-sdk 搭的独立 Web 单页,被 nieta-app 在 `/tag?hashtag=X` 以**跨域 iframe** 内嵌,只读 `/v1/embed/*` 数据,写动作全由宿主承载。每发一版进一个 OSS 版本目录(`.../<activity_uuid>/<version>/`)。
**上线 = 内部把某版本 activate**。你的任务:在 activate 之前,审这个版本的产物有没有踩红线(偷加外站脚本 / 写接口 / 越权 / 自绘宿主顶栏 / 暴露 OSS 真链等),并相对当前线上版指出**变更点**,让 owner 心里有数再上线。

> **真安全边界在后端**(embed token 只读、`/v1/embed/*` 无写接口、token 三向隔离),你的静态审查是**加速人工把关 + 让变更可见**的一层,属 best-effort:产物是打包压缩过的,动态构造 / 混淆可能绕过正则——**拿不准就标「需人工复核」,绝不假装通过**。若能同时拿到创作者交付的**源码**就一起审(源码可读性远高于压缩产物)。

## 0. 配置(token 复用创作者 SDK 那个)
本目录放一个 `.env`(见 `.env.example`):
- `NIETA_API_BASE`:如 `https://pre.api.talesofai.cn`(pre)或 prod 基址。
- `NIETA_ACTIVITY_UUID`:要审的话题活动 uuid。
- `NIETA_DEV_PUBLISH_TOKEN`:**和创作者发布用的是同一个 dev-publish 令牌**(在 app 内「生成开发令牌」拿到,绑该活动、只读)。权限足够:能调 `versions` 列版本;OSS 产物公开可读、下载连令牌都不用。
- `NIETA_DEVELOP_PASS`:pre 联调需要(填 `1`);prod 不设。

## 1. 拉版本清单 + 下载产物
```
node scripts/fetch-versions.mjs                # 只列版本表(谁发草稿 / 谁上线 / 哪个是 active)
node scripts/fetch-versions.mjs --version 9    # 列版本 + 下载第 9 版产物到 _review/v9/
node scripts/fetch-versions.mjs --review       # 下载「当前 active」+「最新草稿」两版,供变更对比
```
脚本做的事:
- `GET {API_BASE}/v1/topic-embed/activities/{uuid}/embed-page/versions`(头 `x-dev-publish-token`,pre 加 `x-develop-pass`)→ 拿 `versions[]`(version / url / created_at / **created_by=谁发的草稿** / 顶层 **activated_by=谁上的线** / activated_at)+ `active_version` + `enabled`。
- 对要审的版本,fetch 它的 OSS `url`(公开,无需令牌)→ `index.html` → 解析其引用的 `<script src>` / `<link href>` / `<img>` 等 → **同源(oss)资源下载到 `_review/vN/`**,**外站资源直接记进 `_review/vN/_external-refs.txt`**(这本身就是审查信号,见 §2 第 1 条)。
- 记录该版本 HTML 的实际响应头 `Content-Security-Policy` 到 `_review/vN/_csp.txt`。

## 2. 按红线逐项审查(详见 `references/checklist.md`)
对 `_review/vN/` 下的产物逐条查(grep / 读),每条判 **[通过] / [可疑] / [违规]** 并附证据(文件 + 匹配片段):
1. **外站资源**:`<script src=>` / `import()` / `<link>` / `<img>` / 字体 / 媒体 指向**非同源、非 `oss.talesofai.cn`** 的域 → 违规(脚本已初筛 `_external-refs.txt`,逐条核)。
2. **写接口痕迹**:`fetch`/`XMLHttpRequest` 带 `method: POST/PUT/DELETE/PATCH`、或打非 `/v1/embed/*` 的写 API → 违规(内嵌页只读)。
3. **token 落地**:`localStorage` / `sessionStorage` / `document.cookie` 写 token → 违规。
4. **history.pushState / replaceState** → 违规(污染宿主返回栈)。
5. **实际 CSP**(看 `_csp.txt`):`script-src` 被放宽(含外站 / `*` / `'unsafe-eval'`)、`connect-src` 多出可疑外站 → 可疑 / 违规。
6. **自绘宿主顶栏(D9)**:`position:fixed|sticky` + `top:0`、「返回 / 分享 / 主页 / 举报」按钮文案、`env(safe-area-inset-*)` 顶部内边距 → 违规(这些宿主已提供,重画=冲突)。
7. **暴露 OSS 真链**:`oss.talesofai.cn` 出现在 `<a href>` / 分享 / 可见文案 → 违规(对外身份须 `app.nieta.art/tag?hashtag=X`)。
8. **越界 API**:`window.parent` 读 DOM/storage、`window.parent.postMessage`、`navigator.serviceWorker.register`、`new EventSource` → 违规。

## 3. 变更对比(相对当前 active)
用 `--review` 同时下了 active 版与待审版后,对比两版的**关键信号集合**(不必逐字 diff 压缩产物):
- 外站域名集合(产物里出现的所有 host)——待审版**新增**了哪些外站?
- `<script src>` 列表、可疑 API 调用、`nieta://` 之外新增的 scheme / 跳转 URL。
给一句结论:**「相对线上 v{active},本版新增风险信号 X / 移除 Y / 无变化」**,让 owner 聚焦变更而非全量。

## 4. 产出报告
输出一份 markdown:
- **版本元信息**:审的是 v?、谁发的(created_by)、当前 active 是 v?(谁上的线 activated_by)。
- **逐红线结论**:[通过] / [可疑] / [违规] + 证据(文件 + 片段)。
- **变更摘要**:相对 active 的新增 / 移除风险信号。
- **上线建议**:`可上线` / `需人工复核(列出哪几项)` / `拒绝上线(列出违规)`。
- 诚实标注静态审查的局限(哪些项只能 best-effort、建议补人工看渲染 / 审源码)。

## 校验门
- 每条 [违规] / [可疑] 都有**文件 + 证据片段**,不空口下结论。
- 没有调用任何写接口、没有 activate、没有回显令牌值。
- 拿不准的标「需人工复核」,不假装通过——漏放一个违规版本上线的代价 >> 多让人复核一项。
