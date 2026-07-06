#!/usr/bin/env node
/**
 * 内嵌话题页上线红线 —— 确定性审查引擎(把 checklist.md 的每条红线变成可执行判定)。
 *
 * 与 fetch-versions.mjs 的分工:
 *   fetch-versions.mjs  取数(列版本 / 下载 OSS 产物到 _review/vN/)。
 *   audit.mjs           判定(对 _review/vN/ 跑 rules.mjs 全部红线 → json + md + 退出码)。
 *
 * 判定基调:严进(可疑即挡)。退出码供自动化流程直接判:
 *   0 = 全通过(可上线)   2 = 有可疑(需人工复核,不放行)   1 = 有违规(拒绝上线)
 *   3 = 运行错误(参数/目录/IO,与审查结论无关)
 *
 * 用法:
 *   node scripts/audit.mjs --dir _review/v9            # 审已下载的某一版目录
 *   node scripts/audit.mjs --dir _review/v9 --base _review/v7   # 审 v9 并与 v7 做变更对比
 *   node scripts/audit.mjs --review                    # 一条龙:fetch active+最新 → 审最新 → 对比 active
 *   node scripts/audit.mjs --dir _review/v9 --json-only # 只输出 json(自动化流程友好,不打人读表)
 *
 * 产出(写进被审目录):
 *   _review/vN/audit-report.json   结构化结果(每条红线 verdict+证据)+ 整体判定 + 退出码
 *   _review/vN/audit-report.md     人读版
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { RULES, ALLOWED_RESOURCE_HOSTS, verdictFromFindings } from "./rules.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_DIR = join(SKILL_ROOT, "_review");

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".htm"]);
const HTML_EXT = new Set([".html", ".htm"]);
const MAX_SCAN_BYTES = 8 * 1024 * 1024; // 单文件扫描上限,避免超大产物拖死(超限记为需人工)

function die(msg) {
  console.error(`[audit] ${msg}`);
  process.exit(3); // 运行错误,与审查结论区分
}

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

/** 递归收集目录下的文本产物文件(跳过审查自身产物 _*.txt / audit-report.* / .map 单独处理)。 */
function collectFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      // 跳过 skill 自己写的辅助文件,只审真产物;.map 不直接当审查文本(它是还原源码的载体,单独处理)
      if (e.name.startsWith("_") || e.name.startsWith("audit-report.") || e.name.endsWith(".map")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 从目录里的 .js.map(hidden sourcemap)还原原始源码文件。
 * vite/tsup 的 map 默认带 `sources`(原始路径)+ `sourcesContent`(原文),故无需第三方 sourcemap 库,
 * 直接读 sourcesContent 即拿到创作者写的 TS/TSX 原文——审查看源码而非压缩产物,可读性天差地别。
 * 返回:{ sources: [{path, content}], mapCount, jsWithMap, jsTotal }
 */
function recoverSourcesFromMaps(dir) {
  const sources = [];
  const seen = new Set();
  let mapCount = 0;
  let jsWithMap = 0;
  const jsFiles = collectFiles(dir).filter((f) => /\.m?js$/i.test(f));
  const jsTotal = jsFiles.length;
  for (const js of jsFiles) {
    const mapPath = js + ".map";
    if (!existsSync(mapPath)) continue;
    jsWithMap += 1;
    let map;
    try {
      map = JSON.parse(readFileSync(mapPath, "utf8"));
    } catch {
      continue;
    }
    mapCount += 1;
    const srcs = map.sources || [];
    const contents = map.sourcesContent || [];
    for (let i = 0; i < srcs.length; i++) {
      const content = contents[i];
      if (typeof content !== "string" || !content) continue;
      // 归一源路径:去掉 webpack/vite 前缀噪声,只保留可读相对路径
      let p = String(srcs[i] || `source-${i}`).replace(/^(?:\.\.\/)+/, "").replace(/^(?:webpack|vite):\/\/\/?/i, "");
      // 只关心创作者自己的源码,跳过 node_modules / SDK 内部(审查目标是创作者代码)
      if (/node_modules|[\\/]\.pnpm[\\/]/.test(p)) continue;
      const key = p + "::" + content.length;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ path: "«src»/" + p, content });
    }
  }
  return { sources, mapCount, jsWithMap, jsTotal };
}

/** 一条规则对一个文件的文本做匹配,返回命中证据数组。 */
function matchRule(rule, relPath, text, lines) {
  const ext = extOf(relPath);
  // scope 过滤
  if (rule.scope === "html" && !HTML_EXT.has(ext)) return [];
  if (rule.scope === "code" && !CODE_EXT.has(ext)) return [];
  // "any" 不过滤

  const flags = "i";
  const evidence = [];

  if (rule.kind === "positive") {
    // positive 规则在 audit 层做"全目录是否存在"的聚合判断,这里逐文件不下结论,交给上层。
    // 但为复用匹配,返回本文件是否命中任一 pattern。
    const hit = rule.patterns.some((re) => new RegExp(re.source, re.flags || flags).test(text));
    return hit ? [{ file: relPath, line: 0, snippet: "(命中 SDK 指纹)" }] : [];
  }

  // negative:逐行找命中,给行号+片段证据
  for (const re of rule.patterns) {
    const rx = new RegExp(re.source, re.flags && re.flags.includes("g") ? re.flags : (re.flags || "") + "g" + (re.flags && re.flags.includes("i") ? "" : "i"));
    let m;
    // 逐行扫描(行号友好);对无换行的压缩单行文件,lines[0] 即整文件,片段做窗口截取
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (rule.allowExempt && line.includes("review-ok")) continue;
      const singleRx = new RegExp(re.source, (re.flags || "").replace("g", "") + (re.flags && re.flags.includes("i") ? "" : "i"));
      const mm = singleRx.exec(line);
      if (mm) {
        const idx = mm.index;
        const snippet = line.slice(Math.max(0, idx - 30), idx + 90).trim();
        evidence.push({ file: relPath, line: li + 1, snippet: snippet.slice(0, 160) });
      }
    }
    void rx;
    void m;
  }
  return evidence;
}

/** 额外:从 _external-refs.txt 判定外站 host(fetch-versions 已分离出的外站引用)。 */
function auditExternalRefs(dir) {
  const p = join(dir, "_external-refs.txt");
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = [];
  for (const line of lines) {
    if (line.startsWith("(")) continue; // "(无外站资源引用)" 之类的说明行
    let host;
    try {
      host = new URL(line).host;
    } catch {
      continue;
    }
    const allowed = ALLOWED_RESOURCE_HOSTS.some((re) => re.test(host));
    if (!allowed) bad.push({ file: "_external-refs.txt", line: 0, snippet: line });
  }
  return bad;
}

/** 审一个已下载的版本目录,返回结构化结果对象。 */
function auditDir(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    die(`目录不存在或不是目录:${dir}(先用 fetch-versions.mjs 下载产物)`);
  }
  const files = collectFiles(dir);
  if (!files.length) die(`目录内无可审产物:${dir}`);

  // 预读文件文本(带大小上限)
  const loaded = [];
  const oversizeSuspect = [];
  for (const full of files) {
    const relPath = relative(dir, full).replace(/\\/g, "/");
    let sz = 0;
    try {
      sz = statSync(full).size;
    } catch {
      continue;
    }
    if (sz > MAX_SCAN_BYTES) {
      oversizeSuspect.push({ file: relPath, line: 0, snippet: `文件 ${(sz / 1048576).toFixed(1)}MB 超扫描上限,未全量审查` });
      continue;
    }
    let text = "";
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    loaded.push({ relPath, text, lines: text.split(/\r?\n/), origin: "artifact" });
  }

  // 源码级审查:用 hidden sourcemap 还原创作者原始 TS/TSX,并入 loaded(标 .tsx 以套 code-scope 规则)。
  // 源码可读性远高于压缩产物——红线判定看还原源码,证据也指向 «src»/原文件:行,人一眼能看懂。
  const recovered = recoverSourcesFromMaps(dir);
  for (const s of recovered.sources) {
    loaded.push({ relPath: s.path, text: s.content, lines: s.content.split(/\r?\n/), origin: "source" });
  }
  const hasSource = recovered.sources.length > 0;

  const findings = [];

  // 源码可得性硬门(强制要求 sourcemap):标准 scaffold+deploy(sourcemap:"hidden")对每个 .js chunk 都生成 .js.map。
  // 任何 .js 缺 map = 没完整走标准发布流程(手动传 / 关了 sourcemap / 删了 map),合规链路被绕过,
  // 且该文件无法源码级审查。强制:缺 map 即 [违规],打回要求按标准流程重发带完整 sourcemap 的版本。
  // (强制 map 后,审查要么源码级、要么直接违规拒绝,不存在"审不了源码"的中间态,故本 skill 不再依赖 cohub 源码兜底。)
  if (recovered.jsTotal > 0 && recovered.mapCount < recovered.jsTotal) {
    const missing = recovered.jsTotal - recovered.mapCount;
    findings.push({
      id: "no-sourcemap",
      title: "产物缺 sourcemap(未走标准发布 / 无法源码级审查)",
      verdict: "violation",
      kind: "negative",
      evidence: [{ file: "(整个产物)", line: 0, snippet: `${missing}/${recovered.jsTotal} 个 .js 缺可用 .js.map(不存在或损坏)` }],
      note:
        "标准 scaffold+deploy 发布(sourcemap:\"hidden\")对每个 .js 都生成 hidden sourcemap(.js.map)。" +
        "有 .js 缺 map = 没完整走标准发布流程(自己写脚本上传 / 关了 sourcemap / 删了 map),合规链路被绕过," +
        "且该文件无法源码级审查。要求创作者按标准流程(scaffold + deploy.mjs)重新发布带完整 sourcemap 的版本再审。",
    });
  }
  for (const rule of RULES) {
    if (rule.kind === "positive") {
      // positive:全目录范围内只要有一个 code 文件命中指纹即算"存在";一个都没命中 = 违规。
      const scoped = loaded.filter((f) => {
        const ext = extOf(f.relPath);
        if (rule.scope === "html") return HTML_EXT.has(ext);
        if (rule.scope === "code") return CODE_EXT.has(ext);
        return true;
      });
      const anyHit = scoped.some((f) =>
        rule.patterns.some((re) => new RegExp(re.source, re.flags || "i").test(f.text)),
      );
      if (!anyHit) {
        findings.push({
          id: rule.id,
          title: rule.title,
          verdict: rule.severity,
          kind: rule.kind,
          evidence: [{ file: "(整个产物)", line: 0, snippet: "未找到任何 SDK 握手指纹(createTopicSDK/getEmbedToken/\"hello\"/{v:2})" }],
          note: rule.note,
        });
      }
      continue;
    }

    // negative:聚合所有文件的命中证据
    const evidence = [];
    for (const f of loaded) {
      evidence.push(...matchRule(rule, f.relPath, f.text, f.lines));
    }
    if (evidence.length) {
      findings.push({
        id: rule.id,
        title: rule.title,
        verdict: rule.severity,
        kind: rule.kind,
        evidence: evidence.slice(0, 20), // 每条最多留 20 条证据,避免报告爆炸
        evidenceTotal: evidence.length,
        note: rule.note,
      });
    }
  }

  // 外站引用(来自 fetch-versions 的 _external-refs.txt)单独并入 external-script 语义
  const badRefs = auditExternalRefs(dir);
  if (badRefs && badRefs.length) {
    findings.push({
      id: "external-resource-ref",
      title: "外站资源引用(样式/图/字体/媒体)",
      verdict: "violation",
      kind: "negative",
      evidence: badRefs.slice(0, 20),
      evidenceTotal: badRefs.length,
      note: "非 oss/api 白名单 host 的资源引用;会被注入 CSP 拦截或构成外部依赖泄露。",
    });
  }

  // 超大文件未全审 → 记一条可疑(严进:宁可让人复核)
  if (oversizeSuspect.length) {
    findings.push({
      id: "oversize-unscanned",
      title: "超大文件未全量审查",
      verdict: "suspect",
      kind: "negative",
      evidence: oversizeSuspect,
      note: `单文件超过 ${(MAX_SCAN_BYTES / 1048576).toFixed(0)}MB 未全量扫描,可能藏未审内容,需人工确认。`,
    });
  }

  const overall = verdictFromFindings(findings);
  return {
    dir: relative(SKILL_ROOT, dir).replace(/\\/g, "/"),
    fileCount: files.length,
    findings,
    overall,
    sourcemap: {
      level: hasSource ? "source" : "artifact-only",
      jsTotal: recovered.jsTotal,
      jsWithMap: recovered.jsWithMap,
      recoveredSources: recovered.sources.length,
    },
  };
}

/** 变更对比:基线目录相对被审目录,红线 id 集合差异。 */
function diffAgainstBase(result, baseDir) {
  if (!baseDir) return null;
  const baseRes = auditDir(baseDir);
  const curIds = new Set(result.findings.map((f) => f.id));
  const baseIds = new Set(baseRes.findings.map((f) => f.id));
  const added = [...curIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !curIds.has(id));
  return {
    baseDir: baseRes.dir,
    baseVerdict: baseRes.overall.label,
    addedRedlines: added,
    removedRedlines: removed,
    summary:
      added.length === 0 && removed.length === 0
        ? "相对基线无红线信号变化"
        : `相对基线:新增红线 [${added.join(", ") || "无"}] / 移除 [${removed.join(", ") || "无"}]`,
  };
}

function renderMarkdown(result, diff, meta) {
  const L = [];
  L.push(`# 内嵌页上线审查报告 — ${result.dir}`);
  L.push("");
  if (meta) {
    L.push(`- 活动 uuid:${meta.activityUuid ?? "(未提供)"}`);
    L.push(`- 审查时机:${meta.stamp ?? "(未标注,由调用方注入时间戳)"}`);
    L.push("");
  }
  L.push(`## 判定:${result.overall.label}（exitCode=${result.overall.exitCode}）`);
  L.push("");
  const sm = result.sourcemap;
  if (sm) {
    if (sm.level === "source") {
      L.push(
        `**审查级别:源码级** ✅ — 用 hidden sourcemap 从 ${sm.jsWithMap}/${sm.jsTotal} 个 .js 还原出 ${sm.recoveredSources} 个源文件,` +
          `红线判定基于创作者原始 TS/TSX 源码(可读性远高于压缩产物,证据指向 «src»/原文件)。`,
      );
    } else {
      L.push(
        `**审查级别:压缩产物级** ⚠ — ${sm.jsTotal} 个 .js 无可用 sourcemap,无法源码级审查。` +
          `已触发 no-sourcemap **违规**(强制要求完整 sourcemap);要求按标准流程(scaffold+deploy)重发带 map 的版本再审。`,
      );
    }
    L.push("");
  }
  L.push(`扫描文件数:${result.fileCount};命中红线:${result.findings.length} 条。`);
  L.push("");
  if (diff) {
    L.push(`## 变更对比`);
    L.push(`- 基线:${diff.baseDir}（${diff.baseVerdict}）`);
    L.push(`- ${diff.summary}`);
    L.push("");
  }
  if (!result.findings.length) {
    L.push("## 逐红线：全部通过 ✅");
  } else {
    L.push("## 命中红线（逐条）");
    for (const f of result.findings) {
      const tag = f.verdict === "violation" ? "[违规]" : f.verdict === "suspect" ? "[可疑]" : "[通过]";
      L.push(`### ${tag} ${f.id} — ${f.title}`);
      if (f.note) L.push(`> ${f.note}`);
      const total = f.evidenceTotal ?? f.evidence.length;
      L.push(`证据（${f.evidence.length}${total > f.evidence.length ? ` / 共 ${total}` : ""}）：`);
      for (const ev of f.evidence) {
        L.push(`- \`${ev.file}\`${ev.line ? `:${ev.line}` : ""} — \`${ev.snippet.replace(/`/g, "'")}\``);
      }
      L.push("");
    }
  }
  L.push("---");
  L.push(
    "> 静态审查为 best-effort:产物压缩,动态构造/混淆可能绕过。[可疑] 项按「严进」拉高整体判定,须人工复核后决策。" +
      "真安全边界在后端(/v1/embed/* 只读 + token 三向隔离)。",
  );
  return L.join("\n");
}

/** 读 .env 为 map(与 fetch-versions.mjs 同款解析;audit 自己也需要读 NIETA_ACTIVITY_UUID 写进报告 meta)。 */
function readEnvFile() {
  const out = {};
  const p = join(SKILL_ROOT, ".env");
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** 占位/空值判定(.env.example 里的 <...> 占位视为未填)。 */
function realValue(v) {
  return v && !v.startsWith("<") ? v : null;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name) {
  return process.argv.includes(name);
}

function runFetch(extraArgs) {
  const fetchScript = join(SKILL_ROOT, "scripts", "fetch-versions.mjs");
  const r = spawnSync(process.execPath, [fetchScript, ...extraArgs], { stdio: "inherit" });
  if (r.status !== 0) die(`fetch-versions.mjs 退出码 ${r.status};无法取产物`);
}

function latestReviewDir() {
  // --review 模式下 fetch 会下载到 _review/vN/;挑 version 号最大的目录作为"待审最新版"
  if (!existsSync(REVIEW_DIR)) return null;
  const vs = readdirSync(REVIEW_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => ({ name: e.name, n: Number(e.name.slice(1)) }))
    .sort((a, b) => b.n - a.n);
  return vs.length ? join(REVIEW_DIR, vs[0].name) : null;
}

function main() {
  const env = readEnvFile();
  const activityUuid = realValue(process.env.NIETA_ACTIVITY_UUID) || realValue(env.NIETA_ACTIVITY_UUID);
  const stamp = arg("--stamp") || null; // 时间戳由调用方注入(脚本内不取系统时间,保持可复现)
  const meta = {
    activityUuid,
    stamp,
  };

  let targetDir = arg("--dir");
  let baseDir = arg("--base");

  if (has("--review")) {
    runFetch(["--review"]);
    targetDir = targetDir || latestReviewDir();
    if (!targetDir) die("--review 后未发现下载的版本目录;检查 fetch-versions 输出");
  }

  if (!targetDir) {
    die("缺少 --dir <目录>(或用 --review 一条龙)。见脚本头注释。");
  }
  targetDir = resolve(SKILL_ROOT, targetDir);
  if (baseDir) baseDir = resolve(SKILL_ROOT, baseDir);

  const result = auditDir(targetDir);
  const diff = baseDir ? diffAgainstBase(result, baseDir) : null;

  const report = {
    schema: "topic-embed-audit/v1",
    meta,
    ...result,
    diff,
  };
  writeFileSync(join(targetDir, "audit-report.json"), JSON.stringify(report, null, 2));
  const md = renderMarkdown(result, diff, meta);
  writeFileSync(join(targetDir, "audit-report.md"), md + "\n");

  if (has("--json-only")) {
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    console.log(md);
    console.log(`\n[audit] 报告已写入 ${relative(SKILL_ROOT, targetDir)}/audit-report.{json,md}`);
    console.log(`[audit] 判定:${result.overall.label} → exitCode ${result.overall.exitCode}`);
  }
  process.exit(result.overall.exitCode);
}

main();
