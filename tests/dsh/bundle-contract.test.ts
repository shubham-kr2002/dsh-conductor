/**
 * DSH bundle contract tests (Phase 10.1)
 *
 * These guard the INSTALLABLE-PACKAGE invariants the clean-room matrix
 * proved once: they must fail the suite forever if the package drifts
 * back into a machine-specific, non-bundle, or incompletely-declared
 * shape. No network, no DSH_HOME, no child DSH process — pure
 * filesystem/manifest reasoning about what `dsh plugin add` would get.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  main?: string;
  type?: string;
  bin?: Record<string, string>;
  files?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dsh?: { bundle?: { patch?: string } };
};

const exists = (rel: string) => existsSync(join(ROOT, rel.replace(/^\.\//, '')));
/** Absolute file URL to a built JS file under dist/, from any compile location. */
const distUrl = (rel: string) => pathToFileURL(join(ROOT, 'dist', rel)).href;

describe('bundle declaration', () => {
  test('declares dsh.bundle.patch pointing at a real file', () => {
    const patch = pkg.dsh?.bundle?.patch;
    assert.ok(patch, 'package.json must declare dsh.bundle.patch');
    assert.ok(patch && exists(patch), `patch file must exist: ${patch}`);
  });

  test('the package itself is named as the loader resolves it', () => {
    // Patch rows import the BARE package name from the profile directory;
    // the name the patch uses must equal this package's own name.
    const patch = pkg.dsh?.bundle?.patch ?? '';
    const text = readFileSync(join(ROOT, patch.replace(/^\.\//, '')), 'utf8');
    assert.match(text, new RegExp(`name:\\s*'?${pkg.name}'?`));
    const ids = [...text.matchAll(/^\s*-?\s*id:\s*([\w./-]+)/gm)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'loader row ids must be unique');
    assert.ok(ids.some((i) => i.includes('conductor')));
    // no local paths anywhere in the distributed patch
    assert.doesNotMatch(text, /\/home\/|Users|[A-Za-z]:\\|file:\/\/|\.\.\//);
  });

  test('exports["."] is the plugin module (what the loader imports by bare name)', () => {
    const dot = (pkg.exports as Record<string, { default?: string } | string>)?.['.'];
    const target = typeof dot === 'string' ? dot : dot?.default;
    assert.ok(target, 'exports["."] must resolve');
    assert.match(String(target), /bundle-entry\.js$/);
    assert.ok(exists(String(target)), 'bundle entry must exist in the build output');
  });

  test('bundle entry exports the official plugin shape (static name + apply)', async () => {
    // dsh unwraps `default ?? namespace`; a function returning a plugin
    // object is the SILENT-INVALID shape in this loader version. Assert we
    // never regress into it.
    const entryPath = join(ROOT, 'dist', 'src', 'dsh', 'bundle-entry.js');
    assert.ok(existsSync(entryPath), 'run the build before the test script (pnpm test does)');
    const mod = (await import(distUrl('src/dsh/bundle-entry.js'))) as Record<string, unknown>;
    assert.equal(mod.name, 'dsh-conductor');
    assert.equal(typeof mod.apply, 'function', 'named apply(ctx, config) must exist');
    const def = mod.default as { name?: string; apply?: unknown } | undefined;
    assert.ok(def && typeof def.apply === 'function', 'default export object with apply');
    assert.notEqual(typeof def, 'function', 'default must NOT be a plugin FACTORY (silent trap)');
  });

  test('library surface stays reachable via ./core', () => {
    const core = (pkg.exports as Record<string, { default?: string } | string>)['./core'];
    const target = typeof core === 'string' ? core : core?.default;
    assert.ok(target && exists(String(target)), 'exports["./core"] must resolve to built JS');
  });
});

describe('portability (never regress to author machines)', () => {
  test('no file:/link:/workspace: dependency specs', () => {
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      assert.doesNotMatch(String(spec), /^(file:|link:|workspace:)/, `${name} is non-portable`);
    }
    const raw = readFileSync(join(ROOT, 'package.json'), 'utf8');
    for (const needle of ['/home/', '/Users/', ':/']) {
      assert.ok(!raw.includes(needle), `manifest must not contain ${needle}`);
    }
  });

  test('cordis is peer-only and never imported by built runtime JS', () => {
    assert.ok(pkg.peerDependencies?.['@deepseek-ai/cordis'], 'declare the cordis peer contract');
    assert.ok(!pkg.dependencies?.['@deepseek-ai/cordis'], 'cordis must not be a hard dependency');
    // The whole point of the structural mirror: compiled output must not
    // contain a bare cordis import that would need a second instance.
    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.js')) files.push(f);
      }
    })(join(ROOT, 'dist', 'src'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      assert.ok(
        !/from\s+["']@deepseek-ai\/cordis["']/.test(src),
        `built runtime JS must not import cordis: ${f}`,
      );
    }
  });

  test('files allow-list covers every runtime artifact the bundle needs', () => {
    const files = pkg.files ?? [];
    assert.ok(files.length > 0, 'explicit files list required');
    const mustCover = [
      'dist/src', // every built module incl. bundle-entry, cli bin, ui assets
      'cordis.patch.yml', // the bundle declaration dsh reads from the package
    ];
    for (const m of mustCover) {
      assert.ok(files.includes(m), `files must include ${m}`);
    }
    // UI assets are part of dist/src (copy-ui-assets writes there); assert
    // they survived into the tree the allow-list publishes.
    assert.ok(exists('dist/src/ui/public/index.html'), 'ui assets must be in the published tree');
  });

  test('validate-package script exists and is wired into prepack', () => {
    const scripts = (pkg as unknown as { scripts?: Record<string, string> }).scripts ?? {};
    assert.match(scripts['validate:package'] ?? '', /validate-package/);
    assert.match(scripts['prepack'] ?? '', /validate-package/, 'prepublish must gate on validation');
  });
});

describe('mount-level lifecycle the bundle depends on', () => {
  test('findActiveByWorkspace adopts open executions and skips terminal ones', async () => {
    const { createRuntime } = (await import(distUrl('src/composition.js'))) as {
      createRuntime: (p?: string) => import('../../src/composition.js').ConductorRuntime;
    };
    const rt = createRuntime(':memory:');
    const { manager } = rt;
    const now = Date.now();
    const mk = (goal: string, final: 'open' | 'paused' | 'done', root: string, updated = now) => {
      const e = manager.createExecution({ goal, workspaceRoot: root });
      e.start('system');
      if (final === 'paused') e.pause('gate');
      if (final === 'done') e.complete('done');
      (e as unknown as { timestamps: { updatedAt: number } }).timestamps.updatedAt = updated;
      manager.executionRepo.save(e);
      return e;
    };
    mk('done-goal', 'done', '/work/a');
    const paused = mk('paused-goal', 'paused', '/work/a');
    mk('other-ws', 'open', '/work/b');

    const adopted = manager.executionRepo.findActiveByWorkspace('/work/a');
    assert.ok(adopted, 'open PAUSED execution for the same workspace is adopted');
    assert.equal(adopted.id, paused.id); // never the COMPLETED one
    assert.equal(adopted.status, 'PAUSED');
    assert.equal(manager.executionRepo.findActiveByWorkspace('/work/none'), null);
    rt.db.close();
  });

  test('mount with reuseOpenExecution re-attaches instead of minting executions', async () => {
    const { createRuntime } = (await import(distUrl('src/composition.js'))) as {
      createRuntime: (p?: string) => import('../../src/composition.js').ConductorRuntime;
    };
    const { mountConductor } = (await import(distUrl('src/dsh/mount.js'))) as {
      mountConductor: (c: object) => import('../../src/dsh/mount.js').ConductorMount;
    };
    const dbPath = join(dirname(fileURLToPath(import.meta.url)), '.tmp-adoption.db');
    try {
      const m1 = mountConductor({
        goal: 'first',
        workspaceRoot: '/adopted/ws',
        dbPath,
        reuseOpenExecution: true,
      });
      const first = m1.executionId;
      m1.close();

      const m2 = mountConductor({
        goal: 'second-should-be-ignored',
        workspaceRoot: '/adopted/ws',
        dbPath,
        reuseOpenExecution: true,
      });
      assert.equal(m2.executionId, first, 'second mount adopts the open execution');
      m2.close();

      const rt = createRuntime(dbPath);
      const rows = rt.manager.executionRepo.list({});
      assert.equal(rows.length, 1, 'adoption must not mint a second execution row');
      // completing it releases adoption: the next mount starts fresh
      const exec = rows[0];
      exec.complete('done');
      rt.manager.executionRepo.save(exec);
      rt.db.close();

      const m3 = mountConductor({
        goal: 'third',
        workspaceRoot: '/adopted/ws',
        dbPath,
        reuseOpenExecution: true,
      });
      assert.notEqual(m3.executionId, first, 'terminal executions are not adopted');
      m3.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          (await import('node:fs')).rmSync(dbPath + suffix, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  });

  test('default mount semantics unchanged (reuse opt-in only)', async () => {
    const { mountConductor } = (await import(distUrl('src/dsh/mount.js'))) as unknown as {
      mountConductor: (c: object) => { executionId: string; close(): void };
    };
    const a = mountConductor({ goal: 'x', workspaceRoot: '/no-reuse', dbPath: ':memory:' });
    const b = mountConductor({ goal: 'y', workspaceRoot: '/no-reuse', dbPath: ':memory:' });
    assert.notEqual(a.executionId, b.executionId);
    a.close();
    b.close();
  });
});
