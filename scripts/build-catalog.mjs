// ============================================================
// RepoVerse — Catalog Builder
// Reads scripts/seed.mjs, verifies every repo against GitHub (via `gh api graphql`),
// pulls live stars / description / language / license / inception year,
// refreshes star counts of the hand-curated repos in js/data.js,
// and writes js/catalog.js.
//
// Usage:  node scripts/build-catalog.mjs        (requires `gh auth login`)
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEW_CATEGORIES as BASE_CATEGORIES, SEED as BASE_SEED } from './seed.mjs';
import { MORE_CATEGORIES, MORE_SEED } from './seed-more.mjs';

const NEW_CATEGORIES = [...BASE_CATEGORIES, ...MORE_CATEGORIES];
const SEED = [...BASE_SEED, ...MORE_SEED];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataSrc = readFileSync(join(root, 'js', 'data.js'), 'utf8');

// ids in data.js don't always match the slug of their display name
const ID_ALIASES = {
  'postgresql': 'postgres',
  'tailwind-css': 'tailwind',
  'rust': 'rust-lang',
  'chromadb': 'chroma',
  'vs-code': 'vscode',
  'vue-js': 'vue',
  'maui': 'net-maui',
};

const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const existingIds = new Set([...dataSrc.matchAll(/^\s{4}id: '([^']+)'/gm)].map(m => m[1]));
const existingFull = [...dataSrc.matchAll(/fullName: '([^']+)'/g)].map(m => m[1]);
const existingFullLower = new Set(existingFull.map(f => f.toLowerCase()));

// ── Parse seed ──────────────────────────────────────────
const warnings = [];
const seen = new Set();
const entries = [];
for (const [category, fullName, name, tags, useCases, rels, flags] of SEED) {
  if (!name) continue;
  const key = fullName.toLowerCase();
  if (existingFullLower.has(key)) { warnings.push(`skip (already in data.js): ${fullName}`); continue; }
  if (seen.has(key)) { warnings.push(`skip (duplicate seed): ${fullName}`); continue; }
  seen.add(key);

  let id = slug(name);
  if (existingIds.has(id) || entries.some(e => e.id === id)) {
    id = slug(fullName.replace('/', '-'));
    warnings.push(`id collision for "${name}" → using "${id}"`);
  }
  const flagList = (flags || '').split(/\s+/).filter(Boolean);
  const yearFlag = flagList.find(f => /^y\d{4}$/.test(f));
  entries.push({
    id, name, fullName, category,
    tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    useCases: useCases.split(';').map(u => u.trim()).filter(Boolean),
    rels: (rels || '').split(',').map(r => r.trim()).filter(Boolean),
    isMcpReady: flagList.includes('mcp'),
    isGateway: flagList.includes('gw'),
    yearOverride: yearFlag ? Number(yearFlag.slice(1)) : null,
  });
}

// ── GitHub GraphQL batch fetch ──────────────────────────
function fetchBatch(fullNames) {
  const fields = 'nameWithOwner url description stargazerCount createdAt isArchived primaryLanguage { name } licenseInfo { spdxId }';
  const body = fullNames.map((fn, i) => {
    const [owner, repo] = fn.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${fields} }`;
  }).join('\n');
  let out;
  try {
    out = execFileSync('gh', ['api', 'graphql', '-f', `query=query { ${body} }`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // gh exits non-zero when some aliases resolve to NOT_FOUND but still prints partial data
    out = err.stdout;
    if (!out) throw err;
  }
  const json = JSON.parse(out);
  return fullNames.map((_, i) => json.data?.[`r${i}`] || null);
}

const allFull = [...entries.map(e => e.fullName), ...existingFull];
const meta = new Map();
for (let i = 0; i < allFull.length; i += 60) {
  const chunk = allFull.slice(i, i + 60);
  fetchBatch(chunk).forEach((m, j) => meta.set(chunk[j], m));
  process.stdout.write(`fetched ${Math.min(i + 60, allFull.length)}/${allFull.length}\r`);
}
console.log();

// ── Assemble ────────────────────────────────────────────
const clean = s => (s || '').replace(/:[a-z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim();
const trimDesc = s => (s.length > 170 ? s.slice(0, 167).replace(/\s+\S*$/, '') + '…' : s);

const newRepos = [];
for (const e of entries) {
  const m = meta.get(e.fullName);
  if (!m) { warnings.push(`NOT FOUND on GitHub, dropped: ${e.fullName}`); continue; }
  if (m.isArchived) warnings.push(`archived (kept): ${m.nameWithOwner}`);
  const desc = trimDesc(clean(m.description) || e.useCases[0] || e.name);
  newRepos.push({
    id: e.id,
    name: e.name,
    fullName: m.nameWithOwner,
    desc,
    url: m.url,
    stars: m.stargazerCount,
    language: m.primaryLanguage?.name || 'Markdown',
    license: (m.licenseInfo?.spdxId && m.licenseInfo.spdxId !== 'NOASSERTION') ? m.licenseInfo.spdxId : 'Other',
    category: e.category,
    tags: e.tags,
    useCases: e.useCases,
    isMcpReady: e.isMcpReady,
    isGateway: e.isGateway,
    year: e.yearOverride || new Date(m.createdAt).getUTCFullYear(),
    ...(m.isArchived ? { archived: true } : {}),
  });
}

const allIds = new Set([...existingIds, ...newRepos.map(r => r.id)]);
const TYPE = { w: 'works-with', a: 'alternative-to', d: 'depends-on' };
const edgeKeys = new Set();
const newRelationships = [];
for (const e of entries) {
  if (!newRepos.some(r => r.id === e.id)) continue;
  for (const rel of e.rels) {
    const [t, rawTarget] = rel.split(':');
    const target = ID_ALIASES[rawTarget] || rawTarget;
    if (!TYPE[t] || !allIds.has(target)) { warnings.push(`unknown relation "${rel}" on ${e.id}`); continue; }
    const k = [e.id, target].sort().join('|');
    if (edgeKeys.has(k) || target === e.id) continue;
    edgeKeys.add(k);
    newRelationships.push({ source: e.id, target, type: TYPE[t] });
  }
}

const liveStars = {};
for (const fn of existingFull) {
  const m = meta.get(fn);
  if (m) liveStars[fn] = m.stargazerCount;
  else warnings.push(`curated repo not found on GitHub: ${fn}`);
}

// ── Write js/catalog.js ─────────────────────────────────
const J = v => JSON.stringify(v);
const repoLine = r => '    ' + J(r);
const out = `// ============================================================
// RepoVerse — Extended Catalog (AUTO-GENERATED — do not edit by hand)
// Source: scripts/seed.mjs → node scripts/build-catalog.mjs
// Generated ${new Date().toISOString().slice(0, 10)} from live GitHub data:
// ${newRepos.length} added repos, ${NEW_CATEGORIES.length} added niches, ${newRelationships.length} added relationships
// ============================================================

(function () {
  const NEW_CATEGORIES = ${J(NEW_CATEGORIES)};

  // Live star counts for the hand-curated repos in data.js
  const LIVE_STARS = ${J(liveStars)};

  const NEW_REPOS = [
${newRepos.map(repoLine).join(',\n')}
  ];

  const NEW_RELATIONSHIPS = [
${newRelationships.map(r => '    ' + J(r)).join(',\n')}
  ];

  CATEGORIES.push(...NEW_CATEGORIES);
  REPOS.forEach(r => { if (LIVE_STARS[r.fullName]) r.stars = LIVE_STARS[r.fullName]; });
  REPOS.push(...NEW_REPOS);
  RELATIONSHIPS.push(...NEW_RELATIONSHIPS);
})();
`;
writeFileSync(join(root, 'js', 'catalog.js'), out);

console.log(warnings.join('\n'));
console.log(`\nWrote js/catalog.js — ${newRepos.length} new repos, ${newRelationships.length} new edges, ${Object.keys(liveStars).length} curated star counts refreshed.`);
