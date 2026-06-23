# 内嵌话题页上线红线审查清单(自包含)

对 `_review/vN/` 下的产物逐项查。grep 建议:`grep -rniE "<pattern>" _review/vN/`。

> 产物是打包压缩的:字符串 / 类名 / URL / 文案通常**保留**(grep 能命中域名、API 路径、中文按钮文案),但变量名被压缩——语义判断(如"这段 fetch 是不是写")要结合上下文读源码片段。**拿不准 → [需人工复核]**,不要漏判也不要瞎判。

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

## 5. 实际 CSP(看 `_review/vN/_csp.txt`)
- `script-src` 含外站域 / `*` / `'unsafe-eval'` → 可疑或违规(基线只该是 `'self' 'unsafe-inline'` + 运营在线白名单下发的已审域)。
- `connect-src` 多出非 API host 的外站 → 可疑(确认是否在已审白名单内)。
- **没有 CSP 响应头** → 违规(deploy 应注入;缺失说明上传链路异常)。

## 6. 自绘宿主顶栏(D9)
- `position\s*:\s*(fixed|sticky)` 配同块 `top\s*:\s*0` → 疑似固定顶栏。
- 文案 / aria:`(返回|分享|主页|首页|举报)` 出现在 `<button` / `onClick` / `aria-label` 附近 → 疑似自绘宿主已提供的按钮。
- `env\(\s*safe-area-inset-top` 或 `padding-top` 配 `safe-area` → 自加顶部安全区(宿主已占,safeTop 恒 0)。
- 判定:命中即 **[可疑]**(合法吸顶二级筛选 tab / 正文含"分享"二字会误报)→ 结合渲染人工确认是不是真画了顶栏 / 返回分享按钮。

## 7. 暴露 OSS 真链
- `oss\.talesofai\.cn` 出现在 `<a href>` / 分享文案 / 可见 `textContent` → 违规(对外身份须 `app.nieta.art/tag?hashtag=X`;OSS url 仅供宿主挂 iframe,不对外)。

## 8. 越界 API
- `window\.parent` 读 DOM / storage、`window\.parent\.postMessage`(应只经 SDK bridge)→ 违规。
- `navigator\.serviceWorker\.register` → 违规(跨域 sandbox iframe 内无效,只污染控制台)。

---

## 判定汇总
- 任一 **[违规]** → 建议 `拒绝上线`,列出违规项 + 证据。
- 仅 **[可疑]**(如 D9 命中但可能是合法吸顶) → 建议 `需人工复核`,指明复核哪项、怎么看(通常是在 app 内挑该版本看渲染)。
- 全 **[通过]** + 变更对比无新增风险信号 → 建议 `可上线`,但仍注明"静态审查 best-effort,最终由 owner 决策"。
