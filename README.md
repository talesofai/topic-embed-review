# topic-embed-review — 内嵌话题页上线安全审查 skill

给运营 / owner 用的**审查** skill,**独立于**创作者 topic-sdk skill(不放 sdk 仓)。放进 cohub space 的 skills 目录,即可让 agent 据此审查一个话题活动的待上线版本。

## 它做什么
拉某话题活动的内嵌页版本清单 → 下载各版本 OSS 产物 → **跑确定性红线审查引擎(`audit.mjs`,红线编码在 `rules.mjs`)** →
对可疑项结合源码人工复核 → 对比版本变更 → 出给 owner 的上线建议报告。**全程只读,不上线、不持用户完整登录态。**

审查判定是**机器可判**的(不是靠 agent 手敲 grep):`audit.mjs` 产出结构化 `audit-report.json` + 人读 `audit-report.md`,
并按判定**退出**(`0`=可上线 / `2`=需人工复核 / `1`=拒绝上线 / `3`=运行错误)——可直接挂自动化流程。

> 覆盖的红线含一条最关键的:**未接入官方 topic-sdk**(产物无 frame-bridge v2 握手指纹)= 拒绝上线。
> 这是"页面自造 postMessage 协议 → 宿主不认 → 白屏"事故的根因,现在上线前就会被引擎当场拦下。

## 输入(两个必需)
1. `NIETA_ACTIVITY_UUID`:要审的话题活动 uuid。
2. **cohub 链接**(`--session`/`--space`/`--cohub <url>` 或 `COHUB_SESSION_URL`/`COHUB_SPACE_URL`):
   被审内嵌页对应的 cohub **space 或 session** 链接(session 自动归一到所属 space 看源码)。
   压缩产物可读性差,审查必须结合源码,故此项是必需输入(见 SKILL §2.5 源码合审)。

## 放进 cohub
把整个 `topic-embed-review/` 目录放进 cohub space 的 skills 位置(如 `.claude/skills/topic-embed-review/`)。agent 看到「审查话题页 / 上线审查 / embed review」类意图即触发。

## 配 token(和创作者 SDK 同一个)
复制 `.env.example` 为 `.env`,填:
- `NIETA_API_BASE`、`NIETA_ACTIVITY_UUID`
- `NIETA_DEV_PUBLISH_TOKEN`:**和创作者发布用同一个 dev-publish 令牌**(app 内「生成开发令牌」,绑该活动、只读)。权限足够审查:能列版本,OSS 产物公开可读。
- `NIETA_DEVELOP_PASS=1`:pre 联调用,prod 不设。

> 为什么够用:审查只需「各版本的页面产物」。版本清单走 `versions` 接口(`x-dev-publish-token` 可调),产物在 OSS(公开读、拿到 url 即可 fetch)。**全程零用户完整登录态、零写权限**——令牌即便泄露也只能读本活动版本清单。

## 跑
```
# 一条龙(推荐,自动化流程主入口):拉版本 → 下载 active+最新草稿 → 跑红线引擎 → 按判定退出
# cohub 链接 space 或 session 皆可:
node scripts/audit.mjs --review --session https://cohub.run/spaces/<spaceId>/sessions/<sessionId>

# 分步
node scripts/fetch-versions.mjs --review              # 只下载 active + 最新草稿到 _review/
node scripts/audit.mjs --dir _review/v9 --base _review/v7   # 审 v9 且与 v7 变更对比
node scripts/audit.mjs --dir _review/v9 --json-only        # 只出 json,供自动化流程消费
```
退出码:`0` 可上线 / `2` 需人工复核(严进:可疑即挡) / `1` 拒绝上线 / `3` 运行错误。
然后 agent 按 `SKILL.md`(§2.5 源码合审 + §3 人工复核可疑项)在引擎报告上补结论、出上线建议。

## 边界(诚实)
静态审查是 best-effort 加速器(产物压缩,动态构造 / 混淆可能绕过),**不替代**真安全边界(后端 `/v1/embed/*` 只读 + token 三向隔离 + 上线前后端红线复检)。拿不准的版本标「需人工复核」,最终 activate 由内部 / owner 决策。
