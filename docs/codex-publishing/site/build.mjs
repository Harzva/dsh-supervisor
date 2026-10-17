#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = resolve(SITE_DIR, "../policies");
const DEFAULT_OUT = resolve(SITE_DIR, "dist");
const PAGE_SOURCES = [
  { slug: "", file: "product.md", label: "Overview" },
  { slug: "support", file: "support.md", label: "Support" },
  { slug: "privacy", file: "privacy-policy.md", label: "Privacy" },
  { slug: "terms", file: "terms-of-service.md", label: "Terms" }
];

const DEFAULTS = {
  baseOrigin: "https://harzva.github.io",
  basePath: "/supervisor/",
  publisherName: "Harzva, developer and maintainer",
  supportEmail: "626609967@qq.com",
  effectiveDate: "2026-10-18",
  supportProcessorsAndRetention: "Support email is handled through QQ Mail/Tencent services; the publisher does not promise automatic deletion after a fixed period. You may request deletion.",
  websiteDataPractices: "The policy site is hosted by GitHub Pages. GitHub may record visitor IP addresses for security; no analytics, advertising cookies, tracking pixels, third-party CDN or support form is added."
};

const args = parseArgs(process.argv.slice(2));
const config = {
  ...DEFAULTS,
  ...(args.config ? JSON.parse(await readFile(resolve(args.config), "utf8")) : {}),
  ...(args.baseOrigin ? { baseOrigin: args.baseOrigin } : {}),
  ...(args.basePath ? { basePath: args.basePath } : {}),
  ...(args.publisher ? { publisherName: args.publisher } : {}),
  ...(args.supportEmail ? { supportEmail: args.supportEmail } : {}),
  ...(args.effectiveDate ? { effectiveDate: args.effectiveDate } : {})
};

const sourceDir = resolve(args.source || DEFAULT_SOURCE);
const outDir = resolve(args.out || DEFAULT_OUT);
const template = await readFile(join(SITE_DIR, "template.html"), "utf8");
const css = await readFile(join(SITE_DIR, "styles.css"), "utf8");
const basePath = normalizeBasePath(config.basePath);
const baseOrigin = normalizeOrigin(config.baseOrigin);
const rootUrl = `${baseOrigin}${basePath}`;
const tokenValues = makeTokenValues(config, rootUrl);
const unresolved = new Set();

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "styles.css"), css, "utf8");

for (const page of PAGE_SOURCES) {
  const sourcePath = join(sourceDir, page.file);
  const source = await readFile(sourcePath, "utf8");
  const title = firstHeading(source) || page.label;
  const bodySource = removeFirstHeading(source);
  const expanded = replaceTokens(bodySource, tokenValues, unresolved);
  const content = markdownToHtml(expanded);
  const pagePath = page.slug ? `${page.slug}/` : "";
  const pageUrl = `${rootUrl}${pagePath}`;
  const outputDir = page.slug ? join(outDir, page.slug) : outDir;
  const cssHref = relative(outputDir, join(outDir, "styles.css")).replaceAll("\\", "/");
  const nav = PAGE_SOURCES.map((item) => {
    const href = directoryHref(outputDir, item.slug ? join(outDir, item.slug) : outDir);
    const current = item.slug === page.slug ? ' aria-current="page"' : "";
    return `<a href="${escapeAttr(href || "./")}"${current}>${escapeHtml(item.label)}</a>`;
  }).join("\n          ");
  const meta = `Effective date: ${config.effectiveDate} · Publisher: ${config.publisherName}`;
  const draftNotice = unresolved.size && args.allowUnresolved
    ? `<aside class="notice" role="status"><strong>Draft preview.</strong> Resolve these deployment values before publishing: ${[...unresolved].map(escapeHtml).join(", ")}.</aside>`
    : "";
  const html = renderTemplate(template, {
    TITLE: escapeHtml(title),
    DESCRIPTION: escapeAttr(descriptionFor(page.label)),
    CANONICAL_URL: escapeAttr(pageUrl),
    CSS_HREF: escapeAttr(cssHref),
    ROOT_HREF: escapeAttr(directoryHref(outputDir, outDir)),
    NAV: nav,
    DRAFT_NOTICE: draftNotice,
    META: escapeHtml(meta),
    CONTENT: content,
    SUPPORT_EMAIL: escapeAttr(config.supportEmail)
  });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "index.html"), html, "utf8");
}

if (unresolved.size && !args.allowUnresolved) {
  throw new Error(`Unresolved policy tokens: ${[...unresolved].join(", ")}. Use a final config or --allow-unresolved for a local preview.`);
}

console.log(`Built ${PAGE_SOURCES.length} policy pages at ${outDir}`);
if (unresolved.size) console.log(`Preview tokens left unresolved: ${[...unresolved].join(", ")}`);

function parseArgs(argv) {
  const result = {};
  const keys = new Map([
    ["allow-unresolved", "allowUnresolved"],
    ["config", "config"],
    ["source", "source"],
    ["out", "out"],
    ["base-origin", "baseOrigin"],
    ["base-path", "basePath"],
    ["publisher", "publisher"],
    ["support-email", "supportEmail"],
    ["effective-date", "effectiveDate"]
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = keys.get(value.slice(2));
    if (!key) throw new Error(`Unknown argument: ${value}`);
    if (key === "allowUnresolved") {
      result[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
    result[key] = next;
    i += 1;
  }
  return result;
}

function normalizeOrigin(value) {
  const origin = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(origin)) throw new Error(`baseOrigin must be an https/http URL: ${value}`);
  return origin;
}

function normalizeBasePath(value) {
  let path = String(value || "/").trim();
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path += "/";
  return path.replaceAll("//", "/");
}

function makeTokenValues(values, rootUrl) {
  return {
    PUBLISHER_LEGAL_NAME: values.publisherName,
    SUPPORT_EMAIL: values.supportEmail,
    WEBSITE_URL: rootUrl,
    SUPPORT_URL: `${rootUrl}support/`,
    PRIVACY_URL: `${rootUrl}privacy/`,
    TERMS_URL: `${rootUrl}terms/`,
    EFFECTIVE_DATE: values.effectiveDate,
    SUPPORT_PROCESSORS_AND_RETENTION: values.supportProcessorsAndRetention,
    WEBSITE_DATA_PRACTICES: values.websiteDataPractices
  };
}

function replaceTokens(value, values, unresolvedTokens) {
  return value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => {
    if (!(name in values) || values[name] === undefined || values[name] === null || String(values[name]).includes(`{{${name}}}`)) {
      unresolvedTokens.add(`{{${name}}}`);
      return whole;
    }
    return String(values[name]);
  });
}

function firstHeading(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function removeFirstHeading(markdown) {
  return markdown.replace(/^#\s+.+\n?/m, "");
}

function markdownToHtml(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeAttr(language)}"` : "";
      html.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (isTableHeader(lines, index)) {
      const rows = [];
      rows.push(splitTableRow(lines[index]));
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push(`<table><thead><tr>${rows[0].map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const list = line.match(/^\s*([-*+])\s+(.+)$/);
    if (list) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${inlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${inlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return html.join("\n");
}

function startsBlock(line) {
  return /^(#{2,6})\s+/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || line.startsWith("```") || line.trim().startsWith("|");
}

function isTableHeader(lines, index) {
  return lines[index].trim().startsWith("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]);
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function inlineMarkdown(value) {
  const tokens = [];
  let source = value.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  source = escapeHtml(source);
  source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g, (_, label, href) => `<a href="${escapeAttr(href)}">${label}</a>`);
  source = source.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  source = source.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  source = source.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  source = source.replace(/_([^_]+)_/g, "<em>$1</em>");
  source = source.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  return source;
}

function renderTemplate(templateText, values) {
  return templateText.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
    return Object.hasOwn(values, key) ? String(values[key]) : whole;
  });
}

function descriptionFor(label) {
  return `${label} information for Harzva Supervisor for Codex.`;
}

function directoryHref(fromDir, targetDir) {
  const href = relative(fromDir, targetDir).replaceAll("\\", "/");
  if (!href || href === ".") return "./";
  return href.endsWith("/") ? href : `${href}/`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
