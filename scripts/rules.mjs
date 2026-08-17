/**
 * 内嵌话题页上线红线 —— 单一事实源(single source of truth)。
 *
 * checklist.md(给人读)与 audit.mjs(机器执行)都以本文件为准:
 * 改红线只改这里,不要在别处手抄正则(手抄=漂移=误判)。
 *
 * 每条规则:
 *   id        稳定标识(报告/退出信号引用它),勿随意改名。
 *   title     人读标题。
 *   severity  命中后的判定基调:
 *               "violation" 命中即 [违规](确定性坏信号,如自设 CSP、写接口、明文令牌)
 *               "suspect"   命中即 [可疑](可能误报,需人工语义复核,如 D9 顶栏、大 base64)
 *             注:本 skill 判定基调为「严进」——[可疑] 也会拉高整体退出码到"需人工",不放行。
 *   kind      "negative" 命中 pattern = 命中该红线(坏);
 *             "positive" **未**命中 pattern = 命中该红线(缺了本该有的东西,如未接入 SDK)。
 *   scope     作用文件类型:"html"(仅 index.html)/ "code"(js/css/html 全部文本产物)/ "any"。
 *   patterns  正则数组(命中任一即算)。positive 规则里 patterns 表示"应存在的特征"。
 *   note      给人读的一句话(为什么这是红线 / 怎么复核)。
 *   allowExempt 是否允许行内 `review-ok` 注释豁免(仅对易误报的 suspect 规则开)。
 *
 * 正则写法注意(产物是压缩后的 JS,且创作者可能用可选链/别名规避):
 *   - postMessage 既要抓 `.postMessage(` 也要抓 `?.postMessage(`,用 `[.?]*\.?` 兜底。
 *   - 大小写不敏感由 audit.mjs 统一加 "i" flag(这里不写 flag)。
 */

/** 允许出现在产物里的资源 host(同源 OSS + 后端 API);其余外站 host = 违规信号。 */
export const ALLOWED_RESOURCE_HOSTS = [
  /(^|\.)oss\.talesofai\.cn$/i,
  /(^|\.)api\.talesofai\.cn$/i,
  /(^|\.)talesofai\.com$/i, // 备用品牌域(与 deploy 注入 CSP 的品牌判定一致)
];

/**
 * 接入官方 SDK 的运行时指纹(frame-bridge v2 握手特征)。
 * 命中其一即视为"产物里确实打进了 topic-sdk 的握手逻辑"。
 * 之所以给多个:tsup/vite 压缩会改写标识符,但**字符串字面量**(method 名 "hello"、协议字段 "v:2")
 * 和拼接方式通常保留;createTopicSDK 作为导出名在未做 mangle-props 时也常保留。
 */
export const SDK_FINGERPRINTS = [
  /createTopicSDK/, // SDK 顶层入口(导出名,常保留)
  /getEmbedToken/, // 换发 embed token 的 bridge method 名(字符串字面量)
  /["']hello["']/, // frame-bridge v2 握手 method 名(字符串字面量)
  /\bv\s*:\s*2\b/, // v2 信封字段 { v: 2, ... }(协议字面量)
];

export const RULES = [
  // ——— 正向断言:必须真正接入官方 SDK(本次白屏事故的根因红线)———
  {
    id: "sdk-integration",
    title: "必须接入官方 topic-sdk(frame-bridge v2 握手)",
    severity: "violation",
    kind: "positive", // 未命中任何指纹 = 违规
    scope: "code",
    patterns: SDK_FINGERPRINTS,
    note:
      "产物里找不到 topic-sdk 的握手指纹(createTopicSDK/getEmbedToken/\"hello\"/{v:2})=页面没接官方 SDK。" +
      "宿主只认 SDK 发起的 frame-bridge v2 hello 握手,自造 postMessage 协议不会被认可 → 必然加载失败白屏。拒绝上线。",
  },
  {
    id: "self-made-bridge",
    title: "疑似自造宿主通信协议(未走 SDK)",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [
      // 直接/可选链/别名调用 parent.postMessage(SDK 内部也用,但配合下方自造 ready 名才判可疑)
      /parent\s*[?.]*\.?\s*postMessage\s*\(/,
      // 自造的 "ready/embed-ready/xxx_ready" 事件名(SDK 从不用这类,是接入方瞎猜协议的典型特征)
      /["'][a-z0-9_-]*(?:embed[_-]?ready|topic[_-]?embed[_-]?ready|nieta[_-]?(?:ready|loaded))[a-z0-9_-]*["']/i,
      /ReactNativeWebView\s*[?.]*\.?\s*postMessage/,
    ],
    note:
      "产物里出现直接 postMessage + 自造 ready 事件名 = 接入方绕过 SDK、自己发明握手协议(本次事故根因)。" +
      "SDK 内部通信不暴露这类自造事件名;命中需人工确认是不是没走 SDK。",
    allowExempt: true,
  },

  // ——— 外站资源 ———
  {
    id: "external-script",
    title: "外站 <script src>",
    severity: "violation",
    kind: "negative",
    scope: "html",
    patterns: [/<script[^>]+src\s*=\s*["']https?:\/\//i],
    note: "外站脚本注入;script 只能同源(oss)。外站 host 逐条核 ALLOWED_RESOURCE_HOSTS。",
  },
  {
    id: "dynamic-external-load",
    title: "动态加载外站 / eval",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [
      /import\s*\(\s*["']https?:\/\//i,
      /document\s*\.\s*createElement\s*\(\s*["']script["']/i,
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
    ],
    note: "动态构造/加载可绕过静态审查;读上下文确认是否加载外站或执行远程代码。",
    allowExempt: true,
  },
  {
    id: "large-base64-media",
    title: "大块 base64 内联媒体",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [/data:(?:image|video|audio)\/[^;]+;base64,[A-Za-z0-9+/]{2048,}/i],
    note: "小图标内联 SVG 可接受;超大 base64 媒体(>~1.5KB 编码)应走 OSS,内联=可疑体积/夹带。",
    allowExempt: true,
  },

  // ——— 写接口 / 非只读 ———
  {
    id: "write-method",
    title: "写接口调用(POST/PUT/DELETE/PATCH)",
    severity: "violation",
    kind: "negative",
    scope: "code",
    patterns: [/method\s*:\s*["'](?:POST|PUT|DELETE|PATCH)["']/i],
    note: "内嵌页只读;写动作一律走 sdk.nav.internal 跳原生页,产物内不应出现写请求。",
  },
  {
    id: "long-connection",
    title: "长连接 / 推送(EventSource/WebSocket)",
    severity: "violation",
    kind: "negative",
    scope: "code",
    patterns: [/new\s+EventSource\s*\(/, /new\s+WebSocket\s*\(/],
    note: "只读页不应有长连接/推送通道。",
  },
  {
    id: "non-embed-api",
    title: "打非 /v1/embed/* 的后端接口",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [/\/v1\/(?!embed\/)[a-z0-9_-]+/i],
    note: "内嵌页只该打只读 /v1/embed/*;命中其它 /v1/ 路径读上下文,确系调用即违规。",
    allowExempt: true,
  },

  // ——— token / 存储 ———
  {
    id: "token-storage",
    title: "token 落地(localStorage/sessionStorage/cookie)",
    severity: "violation",
    kind: "negative",
    scope: "code",
    patterns: [
      /localStorage\s*[.[]/,
      /sessionStorage\s*[.[]/,
      /document\s*\.\s*cookie\s*=/,
    ],
    note: "embed token 只存内存(sdk.auth.getToken());写入持久化存储=违规。",
  },

  // ——— 路由 / 返回栈 ———
  {
    id: "history-pollution",
    title: "history.pushState/replaceState",
    severity: "violation",
    kind: "negative",
    scope: "code",
    patterns: [/history\s*\.\s*(?:pushState|replaceState)\s*\(/],
    note: "污染宿主 App 返回栈;内嵌页应用 hash / 内存路由。",
  },

  // ——— CSP:审"破坏",不审"缺失" ———
  {
    id: "self-set-csp",
    title: "产物自设 CSP <meta>",
    severity: "violation",
    kind: "negative",
    scope: "html",
    patterns: [/<meta[^>]+http-equiv\s*=\s*["']?\s*content-security-policy/i],
    note:
      "CSP 由部署/宿主注入到 OSS 响应头,产物本就不该有;自设 <meta> 会与注入头取交集致白屏 / 试图绕过。" +
      "注意:产物里【没有】CSP 是正常的,绝不因'缺 CSP'判违规。",
  },

  // ——— 自绘宿主顶栏(D9,易误报,严进下仍拉到可疑) ———
  {
    id: "chrome-fixed-top",
    title: "疑似自绘固定顶栏(position:fixed/sticky + top:0)",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [/position\s*:\s*["']?(?:fixed|sticky)[^]{0,120}?\btop\s*:\s*["']?0\b/i],
    note: "宿主顶栏已提供;命中可能是合法吸顶筛选条,需人工看渲染确认是否真画了顶栏。",
    allowExempt: true,
  },
  {
    id: "chrome-host-buttons",
    title: "疑似自绘宿主按钮(返回/分享/主页/举报)",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [
      /(?:<button|onClick|aria-label|role\s*=\s*["']button["'])[^\n]{0,80}(?:返回|分享|主页|首页|举报)/,
      /(?:返回|分享|主页|首页|举报)[^\n]{0,40}(?:<button|onClick|aria-label)/,
    ],
    note: "返回/分享/主页/举报 在宿主顶栏,页面别画(D9);正文含'分享'二字会误报,需人工确认。",
    allowExempt: true,
  },
  {
    id: "chrome-safe-area",
    title: "自加顶部安全区内边距",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [/env\(\s*safe-area-inset-top/i, /(?:padding-top|paddingTop)[^\n]{0,40}safe-area-inset/i],
    note: "宿主已占顶部安全区,sdk.ui.viewport().safeTop 恒为 0;自加会双重内边距。",
    allowExempt: true,
  },

  // ——— 暴露 OSS 真链 ———
  {
    id: "expose-oss-link",
    title: "可见处暴露 OSS 真链",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [
      /<a[^>]+href\s*=\s*["'][^"']*oss\.talesofai\.cn/i,
      /(?:textContent|innerHTML|innerText)\s*[=:][^\n]{0,80}oss\.talesofai\.cn/i,
    ],
    note: "对外身份须 app.nieta.art/tag?hashtag=X;OSS url 仅供宿主挂 iframe,不该出现在可见链接/文案。",
    allowExempt: true,
  },

  // ——— 图片未走 OSS 参数化优化 ———
  {
    id: "unoptimized-oss-image",
    title: "图片疑似原图直出(未走 ossImage/ossImageSrcSet 参数化)",
    severity: "suspect",
    kind: "negative",
    scope: "code",
    patterns: [
      // 锚定 src=/srcSet= 属性本身,不要求 <img 出现在同一行 —— audit.mjs 的 matchRule 是逐行扫描的,
      // Prettier 格式化后多属性 <img> 的 src={} 几乎总是单独一行,要求 "<img...src={" 同行命中面约等于零
      // (实测验证过:同行写法能抓到,换行写法完全漏判)。放宽后会连带命中 <video src>/<iframe src> 甚至
      // 无关对象字面量 { src: x.avatarUrl } —— 可接受:本条是 suspect + allowExempt,宁可多报交给人复核,
      // 也不能为了精确度把真正的违规漏掉(这条规则的唯一价值就是召回率)。
      /\bsrc(?:Set)?\s*=\s*\{(?![^}]*\bossImage)[^}]*\b(?:coverUrl|avatarUrl|bannerPic|smallBannerPic|headerPic|creatorAvatar)\b[^}]*\}/,
    ],
    note:
      "coverUrl/avatarUrl/bannerPic 等都是 OSS 直出图,原图分辨率往往远大于卡片实际渲染尺寸,直出=浪费流量+拖慢加载。" +
      "topic-sdk 提供 `ossImage(url, { width })` / `ossImageSrcSet(url, width)` 按渲染宽度+设备像素比拼 OSS resize/format 参数," +
      "SKILL.md §2 红线小结已收录本条,要求所有图片字段过一遍这个函数再用。命中本条需人工确认:是否真的原图直出。" +
      "已知漏判:① 间接变量赋值(`const src = ossImage(x.coverUrl,{width}); <img src={src}/>` 或反过来不经处理的写法," +
      "本条对两者一视同仁地看不到);② 字段名以外的其它写法(如直接拼字符串)。这两类都不在本条覆盖范围内,best-effort,不是穷举。",
    allowExempt: true,
  },

  // ——— 越界 API ———
  {
    id: "cross-boundary-api",
    title: "越界 API(parent DOM/storage、serviceWorker)",
    severity: "violation",
    kind: "negative",
    scope: "code",
    patterns: [
      /parent\s*[?.]*\.?\s*(?:document|localStorage|sessionStorage)\b/,
      /navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/,
    ],
    note: "跨窗口读 parent 的 DOM/storage=越界;ServiceWorker 在跨域 sandbox iframe 内无效只污染控制台。",
  },

  // ——— 运行期机密泄露 ———
  {
    id: "secret-leak",
    title: "产物夹带机密(令牌/密钥)",
    severity: "violation",
    kind: "negative",
    scope: "any",
    patterns: [
      /\b(?:api[_-]?key|secret|access[_-]?key)\b\s*[:=]\s*["'][^"']{8,}/i,
      /\bbearer\s+[A-Za-z0-9._-]{16,}/i,
      /\beyJ[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/, // JWT 三段式
      /x-dev-publish-token\s*[:=]/i,
    ],
    note:
      "OSS 版本目录公开可读(下载连令牌都不用),任何写进产物的机密=等同公开。JWT/明文 key/bearer 命中即违规。",
  },
  {
    id: "internal-path-leak",
    title: "产物含内部接口 / 后台路径",
    severity: "suspect",
    kind: "negative",
    scope: "any",
    patterns: [
      /\/v1\/topic-embed\//i,
      /upload-grant/i,
      /\b(?:admin|backstage|internal)\b[^\n]{0,40}(?:\.talesofai|\/v1\/)/i,
      /\.internal\.[a-z]/i,
    ],
    note: "内嵌页只该打只读 /v1/embed/*;出现写面接口(/v1/topic-embed/、upload-grant)或内网域名=可疑,读上下文。",
    allowExempt: true,
  },
];

/** 按 severity 汇总一版的红线结果 → 整体判定 + 退出码(严进:suspect 也拉高)。 */
export function verdictFromFindings(findings) {
  const hasViolation = findings.some((f) => f.verdict === "violation");
  const hasSuspect = findings.some((f) => f.verdict === "suspect");
  if (hasViolation) return { verdict: "reject", exitCode: 1, label: "拒绝上线" };
  if (hasSuspect) return { verdict: "needs-review", exitCode: 2, label: "需人工复核" };
  return { verdict: "pass", exitCode: 0, label: "可上线" };
}
