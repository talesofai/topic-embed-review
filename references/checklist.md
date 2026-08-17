# 内嵌话题页上线红线审查清单(人读说明)

> **执行依据是 `scripts/rules.mjs`(唯一事实源)+ `scripts/audit.mjs`(确定性引擎),不是本文件。**
> 本文件只给人读:解释每条红线**为什么**是红线、命中后**怎么人工复核**。正则实现以 rules.mjs 为准;
> 不要照着本文手敲 grep 当审查结论——那正是过去正则漂移 / 漏判的根源。跑 `node scripts/audit.mjs` 拿机器判定。

红线新增了一条最关键的(本文旧版没有,是白屏事故根因):

## 0. 必须接入官方 topic-sdk(rules: `sdk-integration` / `self-made-bridge`)
- `sdk-integration`(**违规**):产物里找不到 SDK 握手指纹(`createTopicSDK` / `getEmbedToken` / `"hello"` / `{v:2}`)
  = 页面根本没接官方 SDK。宿主只识别 SDK 发起的 frame-bridge v2 `hello` 握手;任何自造 postMessage 协议
  **不会被宿主认可** → 页面必然加载失败(白屏)。这是确定性违规,拒绝上线。
- `self-made-bridge`(**可疑**):直接 `window.parent.postMessage(...)`(含可选链 `?.`)配合自造的
  `*-ready` / `embed_ready` / `nieta-ready` 事件名 = 接入方绕过 SDK、自己发明握手协议(事故根因典型特征)。
  SDK 内部通信不暴露这类自造事件名;命中需结合 sourcemap 还原的源码读上下文确认。
- **源码级铁证**:sourcemap 还原的源码(强制要求,见 0b)里若**完全没有** `createTopicSDK` / `getEmbedToken` 握手调用
  = 没接 SDK,直接判 `sdk-integration` 违规(比"`package.json` 有没有依赖"更强:有依赖 ≠ 真用了,有握手调用 = 真接了)。

## 0b. sourcemap 与源码级审查(rules: `no-sourcemap`)
- **为什么审查能拿到源码**:标准 scaffold+deploy 发布的产物,每个 `.js` 都带 `sourcemap:"hidden"` 生成的 `.js.map`
  (map 上了 OSS 但 HTML 不留 `sourceMappingURL` 引用,普通用户/DevTools 看不到)。`fetch-versions.mjs` 会主动探测下载,
  `audit.mjs` 读 map 的 `sourcesContent` **还原原始 TS/TSX**,红线判定跑在还原源码上——这就是"拿不到编译前源码"的解法。
- `no-sourcemap`(**违规**):某版**任何 `.js` 缺可用 `.js.map`**(不存在或损坏) = **没完整走标准发布流程**(自己写脚本上传 / 关了 sourcemap / 删了 map),
  合规链路被绕过,且该文件无法源码级审查。**强制要求每个 `.js` 都带可用 map**——缺一个即违规、拒绝上线,
  打回**要求创作者按标准流程(scaffold+deploy)重发带完整 sourcemap 的版本**再审。(强制 map 后无"审不了源码"的中间态,故不再需要 cohub 源码补强。)

---

以下为历史红线的人读说明(实现见 rules.mjs;审查用 audit.mjs,不要照抄 grep):

## 1. 外站资源(「禁外站显示 / 外站 JS」)
- 外站 `<script src>`:`grep -rniE "<script[^>]+src=[\"']https?://" _review/vN/` → 命中**非 `oss.talesofai.cn`** 即违规。
- 动态加载外站:`import\s*\(` 带 http、`document.createElement\(['\"]script`、`eval\(` → 可疑,读上下文。
- 外站样式 / 图 / 字体 / 媒体:核 `_external-refs.txt` 每一条 host;除 `oss.talesofai.cn` 与后端 API host 外,任何外站域名出现在资源引用 = 违规。
- `data:` 大媒体(base64 图 / 视频 / 音频):`grep -rniE "data:(image|video|audio)/[^;]+;base64" _review/vN/` → 可疑(小图标内联 SVG 可接受,大块 base64 媒体不行)。

## 2. 写接口 / 非只读
- `method\s*:\s*['\"](POST|PUT|DELETE|PATCH)['\"]` → 违规。
- `fetch\(` / `XMLHttpRequest` / `\.ajax\(` 打**非 `/v1/embed/`** 路径 → 读上下文,写则违规。
- `new\s+EventSource` / `new\s+WebSocket` → 违规(只读页不应有长连接 / 推送)。

## 3. token / 存储
- `localStorage` / `sessionStorage` / `document\.cookie\s*=` → 违规(embed token 只存内存)。

## 4. 路由 / 返回栈
- `history\.(pushState|replaceState)` → 违规(应用 hash 路由 / 内存路由,否则污染宿主返回栈)。

## 5. CSP —— 不审"缺不缺",审"产物会不会破坏 CSP 安全预期"
CSP 由**部署 / 宿主动态注入到 OSS 响应头**,产物 HTML 里本就没有、也不该有 CSP(SDK / 创作者产物不管 CSP)。
**所以"产物里没有 CSP"是正常的,绝不报「CSP 缺失 / 违规」。** 审查只看产物有没有**破坏** CSP 预期的行为:
- 产物**自设** `<meta http-equiv="content-security-policy">`:`grep -rniE "http-equiv=[\"']?content-security-policy" _review/vN/` → 命中即违规(页面不该自定义 CSP,会与注入头取交集致白屏 / 试图绕过)。
- 产物引用**外站脚本 / 资源**(本会被注入的 CSP 拦)→ 即 §1 的外站资源违规,这才是 CSP 预期被触碰的真实信号。
- `_csp.txt` **仅供「能取到响应头时」**核对注入是否符合预期(`script-src` 不该含外站 / `*` / `'unsafe-eval'`,`connect-src` 不该多出非 API host 的外站);**取不到 CSP 头(dev 草稿 / 缓存 / 无 token)不算产物违规**,本项跳过。

## 6. 自绘宿主顶栏(D9)
- `position\s*:\s*(fixed|sticky)` 配同块 `top\s*:\s*0` → 疑似固定顶栏。
- 文案 / aria:`(返回|分享|主页|首页|举报)` 出现在 `<button` / `onClick` / `aria-label` 附近 → 疑似自绘宿主已提供的按钮。
- `env\(\s*safe-area-inset-top` 或 `padding-top` 配 `safe-area` → 自加顶部安全区(宿主已占,safeTop 恒 0)。
- 判定:命中即 **[可疑]**(合法吸顶二级筛选 tab / 正文含"分享"二字会误报)→ 结合渲染人工确认是不是真画了顶栏 / 返回分享按钮。

## 7. 暴露 OSS 真链
- `oss\.talesofai\.cn` 出现在 `<a href>` / 分享文案 / 可见 `textContent` → 违规(对外身份须 `app.nieta.art/tag?hashtag=X`;OSS url 仅供宿主挂 iframe,不对外)。

## 7b. 图片未走 OSS 参数化优化(rules: `unoptimized-oss-image`)
- **[可疑]**:`src=`/`srcSet=` 表达式里直接出现 `coverUrl`/`avatarUrl`/`bannerPic`/`smallBannerPic`/`headerPic`/`creatorAvatar` 等已知 OSS 图片字段,且同一表达式内没有 `ossImage`/`ossImageSrcSet` 字样——疑似把后端返回的原图 URL 未经处理就塞进了 `<img>`。
- **为什么审**:这些字段都是 OSS 直出图,原图分辨率往往远超卡片实际渲染尺寸,原图直出=浪费流量、拖慢加载,内部要求必须走 `topic-sdk` 的 `ossImage(url, { width })` / `ossImageSrcSet(url, width)` 按渲染宽度 + 设备像素比拼 OSS resize/format 参数(见 `SKILL.md` §2 红线小结)。
- **已知漏判(best-effort,不是穷举)**:① 间接变量赋值——`const src = ossImage(x.coverUrl, {width}); <img src={src}/>` 这种合规写法,和反过来不经处理的写法,本条都看不到,一视同仁漏判(不产生误导性通过,只是覆盖不到);② 除已知字段名外的其它取图写法(如拼字符串)不在覆盖范围内。
- **怎么复核**:命中即需人工确认——结合 sourcemap 还原源码确认该字段最终是否经过 `ossImage`/`ossImageSrcSet`;也可以直接看网络面板里图片实际请求的分辨率/大小是否与卡片渲染尺寸匹配。确系已优化(只是写法绕过了正则),标 `[通过]` 并注明理由;确系原图直出,升级为需要求创作者改用 `ossImage` 重发。

## 8. 越界 API
- `window\.parent` 读 DOM / storage、`window\.parent\.postMessage`(应只经 SDK bridge)→ 违规。
- `navigator\.serviceWorker\.register` → 违规(跨域 sandbox iframe 内无效,只污染控制台)。

## 9. 运行期机密泄露(产物里不得夹带任何机密)
产物(`index.html` + JS/CSS,含 sourcemap)里**不得出现任何运行期机密**:
- **API key / secret / 令牌**:`grep -rniE "(api[_-]?key|secret|x-token|x-dev-publish-token|access[_-]?key|bearer\s+[A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9._-]{20,})" _review/vN/` → 命中读上下文,确系凭据即违规(embed token 由 SDK 运行期从宿主取,**绝不该硬编码进产物**;dev-publish / x-token 更不该出现)。
- **内部 url / 后台路径**:`grep -rniE "(admin|internal|backstage|ops|/v1/topic-embed/|upload-grant|console\.|\.internal\.)" _review/vN/` → 命中非 `/v1/embed/*` 的内部接口 / 后台路径 / 内网域名即违规(内嵌页只该打只读 `/v1/embed/*`)。
- 判定:命中即至少 **[可疑]**,确认是真机密 / 内部地址即 **[违规]**(拒绝上线)。压缩产物里字符串通常保留,grep 能命中。
> **为什么这条单列(别误判"反正猜不到就安全")**:草稿 / 待审版本的 **OSS 版本目录是公开可读的**——`fetch-versions.mjs` 下载产物**连令牌都不用**(§1 已述)。
> 它**不靠访问控制保护**:`uuid 不可猜` + `草稿未挂载到 /tag`(公众入口看不到) **都不是访问控制**——只要拿到 OSS url(或猜中 `.../<activity_uuid>/<version>/index.html` 结构),任何人都能直接 GET 到产物全文。
> 所以**任何写进产物的机密 = 等同公开**。审查必须把"产物零机密"当硬红线,不能以"草稿没上线 / uuid 难猜"为由放过。

---

## 判定汇总
- 任一 **[违规]** → 建议 `拒绝上线`,列出违规项 + 证据。
- 仅 **[可疑]**(如 D9 命中但可能是合法吸顶) → 建议 `需人工复核`,指明复核哪项、怎么看(通常是在 app 内挑该版本看渲染)。
- 全 **[通过]** + 变更对比无新增风险信号 → 建议 `可上线`,但仍注明"静态审查 best-effort,最终由 owner 决策"。
