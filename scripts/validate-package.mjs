#!/usr/bin/env node
/**
 * Package validation — runs before any bundle install claim is trusted.
 *
 * Fails (exit 1) when the distributable package could not install or boot
 * on ANOTHER machine: absolute author paths, missing bundle declaration,
 * patch referencing nonexistent files, entrypoints pointing at unbuilt
 * output, duplicate plugin ids, or artifacts the npm `files` allow-list
 * would silently drop.
 *
 * Usage: node scripts/validate-package.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const problems = [];
const passed = [];
const fail = (m) => problems.push(m);
const pass = (m) => passed.push(m);

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 1 — bundle declaration ------------------------------------------------------
const patchRel = pkg.dsh?.bundle?.patch;
if (!patchRel) fail('package.json lacks dsh.bundle.patch — this is not a DSH bundle');
else pass(`dsh.bundle.patch = ${patchRel}`);
const patchPath = patchRel ? join(ROOT, patchRel.replace(/^\.\//, '')) : null;
if (patchPath && !existsSync(patchPath)) fail(`patch file missing: ${patchRel}`);

// 2 — no machine-specific anything in the manifest -----------------------------
const home = process.env.HOME ?? '';
const manifest = JSON.stringify(pkg);
for (const needle of ['/home/', '/Users/', ':/']) {
  if (manifest.includes(needle)) fail(`package.json contains local-path marker ${needle}`);
}
if (home && manifest.includes(home)) fail('package.json references $HOME');
for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
  if (/^(file:|link:|workspace:)/.test(String(spec))) fail(`non-portable dependency ${name}@${spec}`);
}
if (!pkg.files || pkg.files.length === 0) fail('package.json has no "files" allow-list (would publish everything)');
if (problems.length === 0) pass('manifest portable: no absolute paths, no file:/link: deps, explicit files list');

// 3 — every declared artifact exists on disk ------------------------------------
const targets = [];
if (pkg.main) targets.push(['main', pkg.main]);
if (pkg.types) targets.push(['types', pkg.types]);
for (const [k, v] of Object.entries(pkg.bin ?? {})) targets.push([`bin:${k}`, v]);
for (const value of Object.values(pkg.exports ?? {})) {
  const leaves = typeof value === 'string' ? [value] : Object.values(value);
  for (const leaf of leaves) if (typeof leaf === 'string' && leaf.startsWith('.')) targets.push(['exports', leaf]);
}
if (patchPath) targets.push(['dsh.bundle.patch', patchRel]);
for (const [kind, rel] of targets) {
  if (!existsSync(join(ROOT, rel))) fail(`${kind} target missing from build output: ${rel}`);
}
pass(`${String(targets.length)} declared entrypoints exist on disk`);

// 4 — patch integrity (regex-level for the loader's accepted subset) -------------
if (patchPath) {
  const text = readFileSync(patchPath, 'utf8');
  if (!/-\s*insert:/m.test(text)) fail('cordis.patch.yml declares no insert: layer');
  const ids = [...text.matchAll(/^\s*-?\s*id:\s*([\w./-]+)/gm)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) fail(`duplicate plugin ids in patch: ${ids.join(', ')}`);
  if (!ids.some((i) => i.includes('conductor'))) fail(`patch ids (${ids.join(', ') || 'none'}) never name conductor`);
  for (const m of text.matchAll(/(name|module|entry|path|file):\s*['"]?([^'"\s#]+)/g)) {
    const v = m[2];
    if (isAbsolute(v) || v.includes('~') || v.startsWith('..')) {
      fail(`patch resolves a local path (${m[1]}: ${v}) — must resolve via package layout`);
    }
  }
  pass(`patch layer sane (ids: ${ids.join(', ') || '—'})`);
}

// 5 — built RUNTIME JS must not embed author paths (tests are not shipped;
// test fixtures legitimately contain fake /home/ paths and are excluded) --
const distDir = join(ROOT, 'dist');
const runtimeDir = join(ROOT, 'dist', 'src');
if (!existsSync(distDir)) fail('dist/ not built — run pnpm build before validation');
else {
  let bad = 0;
  for (const file of walkJs(runtimeDir)) {
    const src = readFileSync(file, 'utf8');
    if (src.includes('/home/') || (home && src.includes(home))) {
      fail(`built JS embeds an absolute author path: ${file}`);
      bad += 1;
      if (bad > 3) break;
    }
  }
  if (bad === 0) pass('built JS free of absolute author paths');
}

// 6 — files allow-list covers every referenced artifact ----------------------------
for (const [kind, rel] of targets) {
  const clean = rel.replace(/^\.\//, '');
  if (clean === 'package.json') continue; // always included in the packed tarball
  const covered = (pkg.files ?? []).some((f) => clean === f || clean.startsWith(f.replace(/\/$/, '') + '/'));
  if (!covered) fail(`${kind} target ${rel} is outside "files" — would be missing after install`);
}
pass('every declared artifact is inside the published file set');

// report ---------------------------------------------------------------------------
for (const line of passed) console.log(`  ✓ ${line}`);
if (problems.length) {
  console.error('\nPACKAGE VALIDATION FAILED:');
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}
console.log(`\npackage validation: PASS (${String(passed.length)} checks)`);
