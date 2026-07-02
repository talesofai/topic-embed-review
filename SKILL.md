---
name: topic-embed-review
description: >-
  审查 nieta-app 内嵌话题页(topic embed)的草稿/待上线版本:拉版本清单、下载各版本 OSS 产物、
  跑确定性红线审查引擎(audit.mjs)产出机器可判的判定 + 结构化报告、对可疑项做人工语义复核、
  对比版本间变更,产出给运营 / owner 的上线建议报告。全程只读——不上线、不改后端、不持用户完整登录态。
  Triggers: 内嵌页审查, 话题页版本审查, 上线审查, embed review, 审查话题页, 安全审查内嵌页, 版本审查。
---

# nieta-app 内嵌话题页 — 上线安全审查 skill

你(agent)是内嵌话题页的**安全 / 合规审查员**,代运营 / owner 审一个话题活动的草稿或待上线版本。
产出是一份**审查报告 + 上线建议**,供运营 / 内部团队决定要不要把某版本 activate(上线)。

**本 skill 的判定核心是确定性脚本 `scripts/audit.mjs`(红线全部编码在 `scripts/rules.mjs`),不是靠你手敲 grep。**
你的职责:跑引擎 → 对引擎标 `[可疑]` 的项做人工语义复核 → 写结论。确定性的交给代码,只有真需要人判断的留给你。

## 你能做 / 不能做(铁律)
- **只读**:拉版本清单、下载 OSS 产物、跑 audit.mjs、读源码、写报告。
- **绝不**:上线(activate / publish prod 仅内部完整登录态,你这个令牌也会被 403)、改后端、提交代码、改产物。
- **绝不持有 / 索取 / 回显用户完整登录态**。你**只用**一个只读的 `x-dev-publish-token`(见 §0),绑单个活动、调不动写接口。
- 报告里**不要打印任何令牌值**。

## 输入(两个必需 + 一个条件)
1. **`NIETA_ACTIVITY_UUID`**(必需):要审的话题活动 uuid。写进 `.env`。
2. **cohub space 链接**(必需):被审内嵌页对应的 cohub space(形如 `https://cohub.run/spaces/<id>`)——
   **产物是压缩的,源码可读性远高于压缩产物**;审查必须结合源码,不能只看压缩 bundle。
   传法:`--space <url>` 或环境变量 `COHUB_SPACE_URL`。它会被记进报告 meta,并触发"源码合审"步骤(§2.5)。
3. **`NIETA_DEV_PUBLISH_TOKEN`**(条件):拉版本清单要用(见 §0)。若你已直接拿到产物目录 / 源码,可只审本地。

## 0. 配置(token 复用创作者 SDK 那个)
本目录放一个 `.env`(见 `.env.example`):
- `NIETA_API_BASE`:如 `https://pre.api.talesofai.cn`(pre)或 prod 基址。
- `NIETA_ACTIVITY_UUID`:要审的话题活动 uuid。
- `NIETA_DEV_PUBLISH_TOKEN`:**和创作者发布同一个 dev-publish 令牌**(app 内「生成开发令牌」,绑该活动、只读)。
- `NIETA_DEVELOP_PASS`:pre 联调填 `1`;prod 不设。
- `COHUB_SPACE_URL`:被审内嵌页对应的 cohub space 链接(也可用 `--space` 传)。

## 1. 一条龙审查(推荐:自动化流程的主入口)
```
node scripts/audit.mjs --review --space https://cohub.run/spaces/<id>
```
它会:① `fetch-versions.mjs --review` 拉版本清单 + 下载「当前 active」和「最新草稿」两版产物 →
② 对最新草稿跑全部红线 → ③ 与 active 做变更对比 → ④ 写 `_review/vN/audit-report.{json,md}` → ⑤ **按判定退出**。

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

## 2. 引擎判定了什么(红线清单见 `scripts/rules.mjs` + 人读说明 `references/checklist.md`)
`rules.mjs` 是**唯一事实源**;checklist.md 只是给人读的说明,不再是执行依据(避免手抄正则漂移)。关键红线:
- **`sdk-integration`(违规)**:产物里找不到 topic-sdk 握手指纹(`createTopicSDK`/`getEmbedToken`/`"hello"`/`{v:2}`)
  = 页面**没接官方 SDK**。宿主只认 SDK 发起的 frame-bridge v2 hello 握手,自造 postMessage 协议不被认可 → 必然白屏。
- **`self-made-bridge`(可疑)**:直接 `postMessage` + 自造 `*-ready` 事件名 = 绕过 SDK 自己发明握手协议。
- 其余:外站资源 / 写接口 / token 落地 / pushState / 自设 CSP / 自绘顶栏(D9)/ 暴露 OSS 真链 / 越界 API / 机密泄露。

## 2.5 源码合审(给了 `--space` 时必做)
引擎审的是**压缩产物**,只能 best-effort。拿到 cohub space 后,**必须**再结合源码确认引擎标 `[可疑]` 的项:
- 打开 space,重点看 `package.json`(有没有 `@talesofai/topic-sdk` 依赖)、入口文件(`main.tsx`/`boot.ts` 等,有没有 `createTopicSDK`)。
- **`package.json` 无 topic-sdk 依赖 = 铁证没接 SDK**,即便引擎因某种字符串巧合没报 `sdk-integration`,你也要在报告里判违规。
- 源码里 `[可疑]` 项(如 D9 顶栏、非 embed API)读上下文确认是真违规还是误报。

## 3. 你(人/agent)的复核职责
引擎判 `2`(可疑)时,**不要直接放行也不要直接拒绝**,逐条复核 `audit-report.json` 的 `[可疑]` 项:
- 结合源码(§2.5)与渲染判断是真违规还是误报(如"分享"二字在正文 vs 真画了分享按钮)。
- 复核结论写进报告:可疑 → 澄清为 `[通过]`(附理由)或升级为 `[违规]`。
- **拿不准就维持"需人工复核",绝不假装通过**——漏放一个违规版本上线的代价 >> 多让人复核一项。

## 4. 产出报告
`audit.mjs` 已生成结构化 `audit-report.json` + 人读 `audit-report.md`。你在其上补:
- **版本元信息**:审的是 v?、谁发的(created_by)、当前 active 是 v?(谁上线 activated_by)、cohub space 链接。
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
- 给了 `--space` 就**必须**做 §2.5 源码合审(至少核 package.json 依赖)。
- 没有调用任何写接口、没有 activate、没有回显令牌值。
