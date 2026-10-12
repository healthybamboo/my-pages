#!/usr/bin/env node
// content/ 配下のディレクトリ構造を走査し、dist/ にコピーしつつ
// ルートおよび各ディレクトリに index.html を自動生成する。依存パッケージなし。
//
//   content/
//     foo.html            -> dist/foo.html            (カードとして一覧に載る)
//     network/
//       bar.html          -> dist/network/bar.html    (dist/network/index.html も生成)
//       index.html        -> そのディレクトリ自体を 1 つの「ページ」として扱い、index は生成しない
//     memo.pdf            -> dist/memo.pdf            (ファイルとしてカードに載る)
//
//   _ や . で始まる名前はスキップ。タイトルは <title>、説明は <meta name="description">
//   または最初の <p> から取得。更新日は git log から（取れなければ mtime）。

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(ROOT, "content");
const DIST = path.join(ROOT, "dist");

const site = await readJson(path.join(ROOT, "site.json"), {
  title: "my-pages",
  description: "",
  lang: "ja",
});

// ---------------------------------------------------------------- helpers

async function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch {
    return fallback;
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function gitDate(absPath) {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", absPath],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function fileDate(absPath) {
  const g = gitDate(absPath);
  if (g) return g;
  const st = await fs.stat(absPath);
  return st.mtime.toISOString();
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_BY_EXT = {
  ".html": "page",
  ".htm": "page",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".md": "text",
  ".txt": "text",
  ".csv": "data",
  ".json": "data",
};

const ICONS = {
  dir: "📁",
  app: "🗂️",
  page: "📄",
  pdf: "📕",
  image: "🖼️",
  text: "📝",
  data: "📊",
  file: "📎",
};

async function readHtmlMeta(absPath) {
  const html = await fs.readFile(absPath, "utf8");
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const descMeta = html.match(
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i,
  )?.[1];
  let description = descMeta ? descMeta.trim() : "";
  if (!description) {
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
    // 「最終更新: ...」のような短いメタ行を避け、ある程度長さのある段落を優先する
    const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1]));
    description = paras.find((t) => t.length >= 24) ?? paras[0] ?? "";
  }
  if (description.length > 140) description = description.slice(0, 140) + "…";
  return { title: title ? stripTags(title) : null, description };
}

// ---------------------------------------------------------------- scan

async function scan(absDir, relDir) {
  const dirents = await fs.readdir(absDir, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name.startsWith(".") || d.name.startsWith("_")) continue;
    const abs = path.join(absDir, d.name);
    const rel = relDir ? `${relDir}/${d.name}` : d.name;

    if (d.isDirectory()) {
      const ownIndex = path.join(abs, "index.html");
      const hasOwnIndex = await fs
        .stat(ownIndex)
        .then((s) => s.isFile())
        .catch(() => false);

      if (hasOwnIndex) {
        // 自前の index.html を持つディレクトリ = 1 つのアプリ/ページとして扱う
        const meta = await readHtmlMeta(ownIndex);
        entries.push({
          kind: "app",
          name: d.name,
          rel,
          href: `${rel}/`,
          title: meta.title || d.name,
          description: meta.description,
          updated: await fileDate(abs),
        });
      } else {
        const children = await scan(abs, rel);
        const flat = flatten(children);
        const updated = flat.map((e) => e.updated).sort().at(-1) ?? null;
        entries.push({
          kind: "dir",
          name: d.name,
          rel,
          href: `${rel}/`,
          title: d.name,
          description: "",
          count: flat.filter((e) => e.kind !== "dir").length,
          children,
          updated,
        });
      }
      continue;
    }

    if (!d.isFile()) continue;
    const ext = path.extname(d.name).toLowerCase();
    const kind = KIND_BY_EXT[ext] ?? "file";
    const st = await fs.stat(abs);
    const base = {
      kind,
      name: d.name,
      rel,
      href: rel,
      ext: ext.replace(".", "").toUpperCase(),
      size: st.size,
      updated: await fileDate(abs),
    };
    if (kind === "page") {
      const meta = await readHtmlMeta(abs);
      entries.push({
        ...base,
        title: meta.title || d.name.replace(/\.html?$/i, ""),
        description: meta.description,
      });
    } else {
      entries.push({ ...base, title: d.name, description: "" });
    }
  }

  // ディレクトリ → ページ → その他、同種は更新日降順
  const order = { dir: 0, app: 1, page: 1 };
  entries.sort((a, b) => {
    const ka = order[a.kind] ?? 2;
    const kb = order[b.kind] ?? 2;
    if (ka !== kb) return ka - kb;
    if (a.updated !== b.updated) return (b.updated ?? "") < (a.updated ?? "") ? -1 : 1;
    return a.name.localeCompare(b.name, "ja");
  });
  return entries;
}

function flatten(entries) {
  const out = [];
  for (const e of entries) {
    out.push(e);
    if (e.kind === "dir") out.push(...flatten(e.children));
  }
  return out;
}

// ---------------------------------------------------------------- render

function card(e, prefix) {
  const href = prefix + encodePath(e.href);
  const icon = ICONS[e.kind] ?? ICONS.file;
  let meta = "";
  if (e.kind === "dir") meta = `${e.count} 件`;
  else if (e.kind === "app") meta = "サイト";
  else if (e.kind === "page") meta = "ページ";
  else meta = `${e.ext} · ${fmtSize(e.size)}`;
  const date = e.updated ? `<time datetime="${esc(e.updated)}">${fmtDate(e.updated)}</time>` : "";
  return `
      <a class="card card--${e.kind}" href="${esc(href)}" data-title="${esc(e.title)}" data-desc="${esc(e.description)}">
        <div class="card__icon" aria-hidden="true">${icon}</div>
        <div class="card__body">
          <h3 class="card__title">${esc(e.title)}</h3>
          ${e.description ? `<p class="card__desc">${esc(e.description)}</p>` : ""}
          <div class="card__meta"><span>${esc(meta)}</span>${date}</div>
        </div>
      </a>`;
}

function breadcrumb(relDir) {
  const parts = relDir ? relDir.split("/") : [];
  const depth = parts.length;
  const items = [`<a href="${"../".repeat(depth) || "./"}">${esc(site.title)}</a>`];
  parts.forEach((p, i) => {
    const up = "../".repeat(depth - i - 1) || "./";
    items.push(
      i === parts.length - 1
        ? `<span aria-current="page">${esc(p)}</span>`
        : `<a href="${up}">${esc(p)}</a>`,
    );
  });
  return items.join('<span class="crumb__sep">/</span>');
}

function renderIndex({ relDir, entries, allPages, buildTime }) {
  const depth = relDir ? relDir.split("/").length : 0;
  const rootPrefix = "../".repeat(depth);
  const heading = relDir ? relDir.split("/").at(-1) : site.title;
  const dirs = entries.filter((e) => e.kind === "dir");
  const pages = entries.filter((e) => e.kind === "page" || e.kind === "app");
  const files = entries.filter((e) => !["dir", "page", "app"].includes(e.kind));
  const total = flatten(entries).filter((e) => e.kind !== "dir").length;

  const section = (title, list, prefix) =>
    list.length
      ? `
    <section class="group">
      <h2 class="group__title">${esc(title)} <span class="group__count">${list.length}</span></h2>
      <div class="grid">${list.map((e) => card(e, prefix)).join("")}
      </div>
    </section>`
      : "";

  // 検索用: 全階層のページ/ファイルをフラットに
  const searchIndex = allPages.map((e) => ({
    t: e.title,
    d: e.description,
    p: e.rel,
    h: rootPrefix + encodePath(e.href),
    k: e.kind,
    u: fmtDate(e.updated),
  }));

  return `<!doctype html>
<html lang="${esc(site.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(relDir ? `${heading} · ${site.title}` : site.title)}</title>
${site.description ? `<meta name="description" content="${esc(site.description)}">` : ""}
<meta name="color-scheme" content="light dark">
<style>
  :root {
    --bg: #f6f5f1;
    --surface: #ffffff;
    --surface-2: #f0efe9;
    --ink: #1b1b19;
    --muted: #6d6c66;
    --line: #e4e2da;
    --accent: #2a6fef;
    --accent-soft: #e6eefd;
    --shadow: 0 1px 2px rgba(20,20,10,.04), 0 8px 24px -12px rgba(20,20,10,.18);
    --radius: 14px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141413;
      --surface: #1e1e1c;
      --surface-2: #262624;
      --ink: #ecebe6;
      --muted: #9a9992;
      --line: #2f2f2c;
      --accent: #7aa7ff;
      --accent-soft: #1f2a44;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.65; -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px; }

  .top {
    position: sticky; top: 0; z-index: 10;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .top .wrap { display: flex; align-items: center; gap: 16px; height: 56px; }
  .brand { font-weight: 700; letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .brand__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .search { margin-left: auto; position: relative; flex: 1; max-width: 380px; }
  .search input {
    width: 100%; height: 36px; padding: 0 12px 0 36px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--surface); color: var(--ink);
    font: inherit; font-size: 14px; outline: none; transition: box-shadow .15s, border-color .15s;
  }
  .search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .search svg { position: absolute; left: 11px; top: 10px; width: 16px; height: 16px; color: var(--muted); pointer-events: none; }
  .search kbd {
    position: absolute; right: 8px; top: 8px; font: 11px/1 ui-monospace, monospace; color: var(--muted);
    border: 1px solid var(--line); border-radius: 5px; padding: 4px 6px; background: var(--surface-2);
  }

  .hero { padding: 44px 0 20px; }
  .crumb { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; }
  .crumb a:hover { color: var(--accent); }
  .crumb [aria-current] { color: var(--ink); font-weight: 600; }
  .crumb__sep { opacity: .5; }
  .hero h1 { font-size: 34px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -.02em; }
  .hero p { margin: 0; color: var(--muted); }
  .stats { display: flex; gap: 14px; margin-top: 18px; font-size: 13px; color: var(--muted); }
  .stats b { color: var(--ink); font-weight: 600; }

  .group { margin: 28px 0; }
  .group__title { font-size: 13px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  .group__count { background: var(--surface-2); border-radius: 999px; padding: 1px 8px; font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }

  .card {
    display: flex; gap: 14px; padding: 16px 16px 14px; background: var(--surface);
    border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);
    transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
    min-height: 96px;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 2px 4px rgba(20,20,10,.04), 0 16px 32px -16px rgba(42,111,239,.35); }
  .card__icon { font-size: 26px; line-height: 1; width: 44px; height: 44px; flex: none; display: grid; place-items: center; border-radius: 11px; background: var(--surface-2); }
  .card--dir .card__icon { background: #fff3d6; }
  .card--page .card__icon, .card--app .card__icon { background: var(--accent-soft); }
  @media (prefers-color-scheme: dark) { .card--dir .card__icon { background: #3a3222; } }
  .card__body { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .card__title { font-size: 16px; font-weight: 650; margin: 0 0 4px; line-height: 1.35; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .card__desc { margin: 0 0 8px; color: var(--muted); font-size: 13px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card__meta { margin-top: auto; display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); }

  .empty { text-align: center; color: var(--muted); padding: 64px 0; }
  .empty code { background: var(--surface-2); padding: 2px 6px; border-radius: 6px; font-size: 13px; }

  .results { display: none; }
  body.searching .browse { display: none; }
  body.searching .results { display: block; }
  .results__path { font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; margin-top: 2px; }

  footer { margin: 64px 0 40px; font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  footer a:hover { color: var(--accent); }
  @media (max-width: 600px) {
    .hero h1 { font-size: 26px; }
    .search kbd { display: none; }
    .brand span.text { display: none; }
  }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="${rootPrefix || "./"}"><span class="brand__dot"></span><span class="text">${esc(site.title)}</span></a>
    <label class="search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="全体を検索…" autocomplete="off" spellcheck="false">
      <kbd>/</kbd>
    </label>
  </div>
</header>

<main class="wrap">
  <div class="hero">
    <nav class="crumb" aria-label="パンくず">${breadcrumb(relDir)}</nav>
    <h1>${esc(heading)}</h1>
    ${!relDir && site.description ? `<p>${esc(site.description)}</p>` : ""}
    <div class="stats">
      <span><b>${total}</b> 件</span>
      ${dirs.length ? `<span><b>${dirs.length}</b> フォルダ</span>` : ""}
      <span>最終ビルド <b>${fmtDate(buildTime)}</b></span>
    </div>
  </div>

  <div class="browse">
    ${section("フォルダ", dirs, rootPrefix)}
    ${section("ページ", pages, rootPrefix)}
    ${section("ファイル", files, rootPrefix)}
    ${
      entries.length === 0
        ? `<div class="empty">まだ何もありません。<br><code>content/</code> にファイルを置いて <code>npm run build</code> してください。</div>`
        : ""
    }
  </div>

  <section class="results">
    <h2 class="group__title">検索結果 <span class="group__count" id="rcount">0</span></h2>
    <div class="grid" id="rgrid"></div>
    <div class="empty" id="rempty" hidden>該当なし</div>
  </section>

  <footer>
    <span>${esc(site.title)}</span>
    <span>content/ から自動生成 · <a href="https://github.com/healthybamboo/my-pages">repo</a></span>
  </footer>
</main>

<script>
(() => {
  const INDEX = ${JSON.stringify(searchIndex)};
  const ICONS = ${JSON.stringify(ICONS)};
  const q = document.getElementById("q");
  const grid = document.getElementById("rgrid");
  const count = document.getElementById("rcount");
  const empty = document.getElementById("rempty");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const norm = (s) => s.normalize("NFKC").toLowerCase();

  function render(list) {
    grid.innerHTML = list.map((e) => \`
      <a class="card card--\${e.k}" href="\${esc(e.h)}">
        <div class="card__icon" aria-hidden="true">\${ICONS[e.k] || ICONS.file}</div>
        <div class="card__body">
          <h3 class="card__title">\${esc(e.t)}</h3>
          \${e.d ? \`<p class="card__desc">\${esc(e.d)}</p>\` : ""}
          <div class="card__meta"><span class="results__path">\${esc(e.p)}</span><span>\${esc(e.u)}</span></div>
        </div>
      </a>\`).join("");
    count.textContent = list.length;
    empty.hidden = list.length > 0;
  }

  function search() {
    const terms = norm(q.value).split(/\\s+/).filter(Boolean);
    if (!terms.length) { document.body.classList.remove("searching"); return; }
    document.body.classList.add("searching");
    const hits = INDEX.filter((e) => {
      const hay = norm([e.t, e.d, e.p].join(" "));
      return terms.every((t) => hay.includes(t));
    });
    render(hits);
  }

  q.addEventListener("input", search);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== q) { ev.preventDefault(); q.focus(); }
    if (ev.key === "Escape" && document.activeElement === q) { q.value = ""; search(); q.blur(); }
  });
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- build

async function copyTree(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const d of await fs.readdir(src, { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name.startsWith("_")) continue;
    const s = path.join(src, d.name);
    const t = path.join(dst, d.name);
    if (d.isDirectory()) await copyTree(s, t);
    else if (d.isFile()) await fs.copyFile(s, t);
  }
}

async function writeIndexes(entries, relDir, allPages, buildTime) {
  const outDir = path.join(DIST, relDir);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, "index.html"),
    renderIndex({ relDir, entries, allPages, buildTime }),
  );
  for (const e of entries) {
    if (e.kind === "dir") await writeIndexes(e.children, e.rel, allPages, buildTime);
  }
}

async function main() {
  const t0 = Date.now();
  await fs.mkdir(CONTENT, { recursive: true });
  await fs.rm(DIST, { recursive: true, force: true });
  await copyTree(CONTENT, DIST);

  const tree = await scan(CONTENT, "");
  const allPages = flatten(tree).filter((e) => e.kind !== "dir");
  const buildTime = new Date().toISOString();
  await writeIndexes(tree, "", allPages, buildTime);
  await fs.writeFile(path.join(DIST, ".nojekyll"), "");

  const dirs = flatten(tree).filter((e) => e.kind === "dir").length;
  console.log(
    `built dist/: ${allPages.length} items, ${dirs + 1} index pages (${Date.now() - t0}ms)`,
  );
  for (const e of flatten(tree)) {
    console.log(`  ${e.kind.padEnd(5)} ${e.rel}${e.kind === "dir" ? "/" : ""}  ${e.title}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
