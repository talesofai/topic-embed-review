# topic-embed-review — 内嵌话题页上线安全审查 skill

给运营 / owner 用的**审查** skill,**独立于**创作者 topic-sdk skill(不放 sdk 仓)。放进 cohub space 的 skills 目录,即可让 agent 据此审查一个话题活动的待上线版本。

## 它做什么
拉某话题活动的内嵌页版本清单 → 下载各版本 OSS 产物 → 按上线红线静态审查(只读 / CSP / 外站资源 / 写接口 / 自绘宿主顶栏 / pushState / token 存储)→ 对比版本变更 → 出给 owner 的上线建议报告。**全程只读,不上线、不持用户完整登录态。**

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
node scripts/fetch-versions.mjs            # 先看版本表(哪个 active、谁发的、谁上线的)
node scripts/fetch-versions.mjs --review   # 下载 active + 最新草稿两版到 _review/,供变更对比
```
然后 agent 按 `SKILL.md` + `references/checklist.md` 审 `_review/` 下产物、出报告。

## 边界(诚实)
静态审查是 best-effort 加速器(产物压缩,动态构造 / 混淆可能绕过),**不替代**真安全边界(后端 `/v1/embed/*` 只读 + token 三向隔离 + 上线前后端红线复检)。拿不准的版本标「需人工复核」,最终 activate 由内部 / owner 决策。
