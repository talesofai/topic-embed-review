#!/usr/bin/env node
/**
 * 内嵌话题页审查工具:列版本 + 下载 OSS 产物(只读,绝不调写接口、绝不 activate)。
 *
 * 用法:
 *   node scripts/fetch-versions.mjs               # 只列版本表(谁发草稿 / 谁上线 / 哪个 active)
 *   node scripts/fetch-versions.mjs --version 9   # 列版本 + 下载第 9 版产物到 _review/v9/
 *   node scripts/fetch-versions.mjs --review      # 下载「当前 active」+「最新草稿」两版,供变更对比
 *
 * 凭据来自本 skill 目录的 .env:
 *   NIETA_API_BASE / NIETA_ACTIVITY_UUID / NIETA_DEV_PUBLISH_TOKEN / NIETA_DEVELOP_PASS(pre 用)
 * dev-publish 令牌:与创作者发布同一个,只读、绑该活动;OSS 产物公开可读,下载无需令牌。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_DIR = join(SKILL_ROOT, "_review");

function loadEnv() {
  const p = join(SKILL_ROOT, ".env");
  if (existsSync(p)) {
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
  const apiBase = (process.env.NIETA_API_BASE || "").replace(/\/+$/, "");
  const uuid = process.env.NIETA_ACTIVITY_UUID;
  const token = process.env.NIETA_DEV_PUBLISH_TOKEN;
  if (!apiBase || !uuid || !token || uuid.startsWith("<") || token.startsWith("<")) {
    console.error("[review] 缺少 .env:NIETA_API_BASE / NIETA_ACTIVITY_UUID / NIETA_DEV_PUBLISH_TOKEN(见 .env.example)");
    process.exit(1);
  }
  return { apiBase, uuid, token, developPass: process.env.NIETA_DEVELOP_PASS };
}

function authHeaders(env) {
  const h = { "x-dev-publish-token": env.token };
  if (env.developPass) h["x-develop-pass"] = env.developPass;
  return h;
}

async function getVersions(env) {
  const url = `${env.apiBase}/v1/topic-embed/activities/${encodeURIComponent(env.uuid)}/embed-page/versions`;
  const resp = await fetch(url, { headers: authHeaders(env) });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`[review] 列版本失败 HTTP ${resp.status}: ${text}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

function printTable(state) {
  const active = state.active_version;
  console.log(
    `\n[review] enabled=${state.enabled}  active=v${active}  上线者(activated_by)=${state.activated_by ?? "-"}  上线时间=${state.activated_at ?? "-"}`,
  );
  console.log("  version\tcreated_by(发草稿)\tcreated_at\turl");
  for (const v of (state.versions || []).slice().sort((a, b) => b.version - a.version)) {
    const mark = v.version === active ? " ←LIVE" : "";
    console.log(`  v${v.version}${mark}\t${v.created_by ?? "-"}\t${v.created_at ?? "-"}\t${v.url}`);
  }
  console.log("");
}

async function downloadVersion(env, ver, url) {
  const dir = join(REVIEW_DIR, `v${ver}`);
  mkdirSync(dir, { recursive: true });

  const resp = await fetch(url); // OSS 公开,无需令牌
  const csp = resp.headers.get("content-security-policy") || "(无 CSP 响应头!— 异常,记 [违规])";
  const html = await resp.text();
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, "_csp.txt"), csp + "\n");

  const baseDir = url.replace(/[^/]*$/, ""); // 版本目录 url(去掉 index.html)
  const ossHost = new URL(url).host;
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const external = [];
  const downloaded = [];
  for (const ref of [...new Set(refs)]) {
    if (ref.startsWith("data:") || ref.startsWith("#")) continue;
    let abs;
    try {
      abs = new URL(ref, url);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    if (abs.host !== ossHost) {
      external.push(abs.href);
      continue;
    }
    try {
      const r = await fetch(abs.href);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const rel = abs.href.startsWith(baseDir) ? abs.href.slice(baseDir.length) : abs.pathname.split("/").pop();
      const out = join(dir, rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, buf);
      downloaded.push(rel);
    } catch {
      /* 下载失败忽略,审查时会发现缺文件 */
    }
  }
  writeFileSync(
    join(dir, "_external-refs.txt"),
    external.length ? external.join("\n") + "\n" : "(index.html 内无外站资源引用)\n",
  );
  console.log(`[review] v${ver} → ${dir}`);
  console.log(`  index.html + ${downloaded.length} 个同源资源已下载;CSP 见 _csp.txt`);
  if (external.length) console.log(`  ⚠ ${external.length} 个外站资源引用(见 _external-refs.txt,逐条核红线 §1)`);
}

async function main() {
  const env = loadEnv();
  const state = await getVersions(env);
  printTable(state);

  const args = process.argv.slice(2);
  const byVer = (n) => (state.versions || []).find((v) => v.version === n);
  let targets = [];
  if (args.includes("--review")) {
    const active = state.active_version;
    const versions = (state.versions || []).map((v) => v.version);
    const latest = versions.length ? Math.max(...versions) : null;
    targets = [...new Set([active, latest].filter((x) => x != null))];
    console.log(`[review] --review:下载 active(v${active}) + 最新(v${latest})供对比`);
  } else {
    const vi = args.indexOf("--version");
    if (vi >= 0 && args[vi + 1]) targets = [Number(args[vi + 1])];
  }
  for (const n of targets) {
    const v = byVer(n);
    if (!v) {
      console.error(`[review] 版本 v${n} 不在清单,跳过`);
      continue;
    }
    await downloadVersion(env, n, v.url);
  }
  if (!targets.length) console.log("[review] 仅列版本;加 --version N 或 --review 下载产物再审。");
}

main().catch((e) => {
  console.error("[review]", e?.stack || String(e));
  process.exit(1);
});
