---
name: topic-embed-review
description: >-
  审查 nieta-app 内嵌话题页(topic embed)的草稿/待上线版本:拉版本清单、下载各版本 OSS 产物、
  跑确定性红线审查引擎(audit.mjs)产出机器可判的判定 + 结构化报告、对可疑项做人工语义复核、
  对比版本间变更,产出给运营 / owner 的上线建议报告。全程只读——不上线、不改后端、不持用户完整登录态。
  Triggers: 内嵌页审查, 话题页版本审查, 上线审查, embed review, 审查话题页, 安全审查内嵌页, 版本审查。
---

# nieta-app 内嵌话题页 — 上线安全审查 skill

## ⚠ 开工前必做：自我更新（不允许跳过）

每次一个审查会话开始、第一次调用 `fetch-versions.mjs`/`audit.mjs` 之前(会话内后续重跑不用重复做这步),先确认手上这份 `topic-embed-review/` 不是过期副本:

- 本目录是 git 仓库(有 `.git`)、且当前在 `main` 分支(`git branch --show-current` 确认):`git pull --ff-only origin main`。拉不动 → 停下来向用户说明情况,不要在不确定的版本上出上线建议。当前不在 `main`(比如别人留下的分支):`git fetch origin main` 看落后多少即可,不要擅自切分支/强制同步——这份 checkout 不一定只有你在用。
- 本目录是从别处复制来的纯拷贝(比如放进了 cohub space 的 skills 目录):去 `https://github.com/talesofai/topic-embed-review` 重新拉取最新内容,只覆盖 `SKILL.md`/`references/`/`scripts/` 这些 skill 自身文件——**绝不覆盖或删除 `.env`(里面是活的 `NIETA_DEV_PUBLISH_TOKEN`)、`_review/`(此前的审查产物/证据)、任何本地未提交的修改**。如果仓库是私有的(拉取需要鉴权而你没有对应凭据),如实告诉用户"无法确认是否为最新版本",不要假装拉取成功就继续审查。
- **没有"看起来没变就跳过"这种例外**——每个审查会话都要做一次这一步。红线编码在 `rules.mjs`,随时可能新增/调整;拿旧红线审查,等于让本该拦下的问题溜过去。
- **这只是文字引导,不是机器强制**：真正兜底新鲜度的是 `rules.mjs`/`audit.mjs` 本身要不要做版本校验，这条尚未实现（见仓库 issue / 后续 PR），本节目前只能靠你自觉执行。

---

你(agent)是内嵌话题页的**安全 / 合规审查员**,代运营 / owner 审一个话题活动的草稿或待上线版本。
产出是一份**审查报告 + 上线建议**,供运营 / 内部团队决定要不要把某版本 activate(上线)。

**本 skill 的判定核心是确定性脚本 `scripts/audit.mjs`(红线全部编码在 `scripts/rules.mjs`),不是靠你手敲 grep。**
你的职责:跑引擎 → 对引擎标 `[可疑]` 的项做人工语义复核 → 写结论。确定性的交给代码,只有真需要人判断的留给你。

## 你能做 / 不能做(铁律)
- **只读**:拉版本清单、下载 OSS 产物、跑 audit.mjs、读源码、写报告。
- **绝不**:上线(activate / publish prod 仅内部完整登录态,你这个令牌也会被 403)、改后端、提交代码、改产物。
- **绝不持有 / 索取 / 回显用户完整登录态**。你**只用**一个只读的 `x-dev-publish-token`(见 §0),绑单个活动、调不动写接口。
- 报告里**不要打印任何令牌值**。

## 输入(两个必需)
1. **`NIETA_ACTIVITY_UUID`**(必需):要审的话题活动 uuid。写进 `.env`。
2. **`NIETA_DEV_PUBLISH_TOKEN`**(必需):拉版本清单要用(见 §0)。若你已直接拿到产物目录,可只审本地(`--dir`)。

> **源码从哪来:sourcemap 还原,不需要 cohub。** 标准 scaffold+deploy 发布的产物每个 `.js` 都带 hidden
> sourcemap(`.js.map`),审查方主动取 `.js.map` 就能 100% 还原创作者原始 TS/TSX 源码(见 §2)。
> **强制要求:每个 `.js` 都得有可用 map** —— 缺一个即判 `no-sourcemap` **违规**、拒绝上线、打回重发。
> 于是审查只有两种结局:有完整 map → 源码级审;缺 map → 违规拒绝。**不再需要 cohub / session / space 链接。**

## 0. 配置(token 复用创作者 SDK 那个)
本目录放一个 `.env`(见 `.env.example`):
- `NIETA_API_BASE`:如 `https://pre.api.talesofai.cn`(pre)或 prod 基址。
- `NIETA_ACTIVITY_UUID`:要审的话题活动 uuid。
- `NIETA_DEV_PUBLISH_TOKEN`:**和创作者发布同一个 dev-publish 令牌**(app 内「生成开发令牌」,绑该活动、只读)。
- `NIETA_DEVELOP_PASS`:pre 联调填 `1`;prod 不设。

## 1. 一条龙审查(推荐:自动化流程的主入口)
```
node scripts/audit.mjs --review
```
它会:① `fetch-versions.mjs --review` 拉版本清单 + 下载「当前 active」和「最新草稿」两版产物(含每个 `.js` 的 hidden `.js.map`) →
② 对最新草稿跑全部红线(判定基于 sourcemap 还原的源码) → ③ 与 active 做变更对比 → ④ 写 `_review/vN/audit-report.{json,md}` → ⑤ **按判定退出**。

**退出码(自动化流程直接判):**
- `0` = 全通过 → 建议 **可上线**
- `2` = 有 `[可疑]` → **需人工复核**(严进:可疑即挡,不放行)
- `1` = 有 `[违规]` → **拒绝上线**
- `3` = 运行错误(参数/目录/IO,与审查结论无关)

分步用法:
```
node scripts/fetch-versions.mjs --review            # 只下载,不判定
node scripts/audit.mjs --dir _review/v9             # 审已下载的某版
node scripts/audit.mjs --dir _review/v9 --base _review/v7   # 审 v9 且与 v7 对比
node scripts/audit.mjs --dir _review/v9 --json-only # 只出 json(自动化流程消费,不打人读表)
```

## 2. 源码级审查(核心:靠 sourcemap 还原,不跟压缩产物较劲)
标准 scaffold+deploy 发布的产物,每个 `.js` 旁都带一个 **hidden sourcemap**(`.js.map`):map 上了 OSS
但 HTML/JS 里不留 `sourceMappingURL` 引用——**普通用户/DevTools 看不到,但审查方主动取 `.js.map` 就能 100% 还原
创作者原始 TS/TSX 源码**。这就是"审查拿不到编译前源码"这个难题的解法:
- `fetch-versions.mjs` 下载产物时会**自动探测并下载每个 `.js` 的 `.js.map`**(它不在 HTML 引用里,靠约定路径探测)。
- `audit.mjs` 读 `.js.map` 的 `sourcesContent` **还原出源文件**,红线判定跑在**还原源码**上,证据指向 `«src»/原文件:行`。
  报告顶部标 **审查级别:源码级 ✅ / 压缩产物级 ⚠**,一眼知道这次审的是源码还是压缩代码。

`rules.mjs` 是红线**唯一事实源**;checklist.md 只是人读说明(避免手抄正则漂移)。关键红线:
- **`sdk-integration`(违规)**:找不到 topic-sdk 握手指纹(`createTopicSDK`/`getEmbedToken`/`"hello"`/`{v:2}`)
  = 页面**没接官方 SDK**。宿主只认 SDK 的 frame-bridge v2 hello 握手,自造 postMessage 协议不被认可 → 必然白屏。
- **`no-sourcemap`(违规)**:某版**任何 `.js` 缺可用 `.js.map`**(不存在或损坏) = **没完整走标准发布流程**
  (自己写脚本传 / 关了 sourcemap / 删了 map),合规链路被绕过,且该文件无法源码级审查。**强制要求每个 `.js` 都带可用 map**——
  缺一个即违规、拒绝上线,打回按标准流程(scaffold+deploy)重发带完整 sourcemap 的版本再审。
- **`self-made-bridge`(可疑)**:直接 `postMessage` + 自造 `*-ready` 事件名 = 绕过 SDK 自己发明握手协议。
- **`unoptimized-oss-image`(可疑)**:`src=`/`srcSet=` 直出 `coverUrl`/`avatarUrl`/`bannerPic` 等已知 OSS 图片字段、未经 `ossImage`/`ossImageSrcSet`(topic-sdk 提供)处理 = 疑似原图直出,内部要求必须走参数化优化,详见 checklist §7b。
- 其余:外站资源 / 写接口 / token 落地 / pushState / 自设 CSP / 自绘顶栏(D9)/ 暴露 OSS 真链 / 越界 API / 机密泄露。

> 源码级审查的源码**全部来自 sourcemap 还原**(§2 上文);既然强制每个 `.js` 都带可用 map,还原不出源码的版本
> 已经被 `no-sourcemap` 违规挡在门外,**不存在"审不了源码需要外部兜底"的场景,故不再有 cohub / session / space 源码合审步骤。**

## 3. 你(人/agent)的复核职责
引擎判 `2`(可疑)时,**不要直接放行也不要直接拒绝**,逐条复核 `audit-report.json` 的 `[可疑]` 项:
- 结合 sourcemap 还原的源码(§2)与渲染判断是真违规还是误报(如"分享"二字在正文 vs 真画了分享按钮)。
- 复核结论写进报告:可疑 → 澄清为 `[通过]`(附理由)或升级为 `[违规]`。
- **拿不准就维持"需人工复核",绝不假装通过**——漏放一个违规版本上线的代价 >> 多让人复核一项。

## 4. 产出报告
`audit.mjs` 已生成结构化 `audit-report.json` + 人读 `audit-report.md`。你在其上补:
- **版本元信息**:审的是 v?、谁发的(created_by)、当前 active 是 v?(谁上线 activated_by)。
- **人工复核结论**:对每条 `[可疑]` 的最终判定 + 理由(结合源码/渲染)。
- **上线建议**:`可上线` / `需人工复核(列出哪几项)` / `拒绝上线(列出违规)`,与引擎退出码一致或说明为何调整。
- **上线三元组(建议 `可上线` 时必给)**:
  ① 建议 activate 的 **version**;② 该 version 的 **activity_uuid**;③ **当前 active version**(无则注明)。
  > **交接指针**:审查只产报告,**不 activate、不上线**(scoped 令牌也调不动 prod)。把报告 + 三元组交
  > **内部运营(`is_internal` 账号)**,由其按 `skill-internal-publish/`(topic-sdk 仓根)runbook 执行 activate。
- 诚实标注静态审查局限(哪些只能 best-effort、建议补人工看渲染)。

## 校验门
- 审查结论以 `audit.mjs` 退出码 + `audit-report.json` 为准,人工复核只收窄不放宽(可疑不能无理由改通过)。
- 每条 [违规] / [可疑] 都有**文件 + 证据片段**(引擎已附),不空口下结论。
- 缺 sourcemap 的版本一律 `no-sourcemap` 违规、拒绝上线,不做"压缩产物级放行"。
- 没有调用任何写接口、没有 activate、没有回显令牌值。
