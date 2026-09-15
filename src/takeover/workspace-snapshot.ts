/**
 * Workspace Snapshot
 *
 * Captures observable workspace state at takeover-freeze and at continue
 * time, and computes the human modifications made in between. Git-based
 * when available; falls back to a bounded filesystem scan otherwise.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface WorkspaceFileState {
  path: string; // relative to root
  size: number;
  mtimeMs: number;
}

export interface WorkspaceSnapshot {
  root: string;
  takenAt: number;
  isGitRepo: boolean;
  branch?: string;
  headCommit?: string;
  /** `git status --porcelain` entries at capture time (may be empty). */
  gitStatus: string[];
  files: WorkspaceFileState[];
}

export interface WorkspaceDiff {
  created: string[];
  modified: string[];
  deleted: string[];
  gitStatusAdded: string[];
}

/** Injectable so tests can run without git. */
export type GitRunner = (args: string[], cwd: string) => { ok: boolean; stdout: string };

export const spawnGit: GitRunner = (args, cwd) => {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.conductor', '.dsh', 'coverage']);
const MAX_FILES = 5000;

export function scanWorkspaceFiles(root: string, maxFiles: number = MAX_FILES): WorkspaceFileState[] {
  const out: WorkspaceFileState[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(full);
        out.push({
          path: relative(root, full),
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
        });
        if (out.length >= maxFiles) break;
      } catch {
        // raced deletion — ignore
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function captureWorkspaceSnapshot(
  root: string,
  git: GitRunner = spawnGit,
): WorkspaceSnapshot {
  const probe = git(['rev-parse', '--is-inside-work-tree'], root);
  const isGitRepo = probe.ok && probe.stdout === 'true';

  const snapshot: WorkspaceSnapshot = {
    root,
    takenAt: Date.now(),
    isGitRepo,
    gitStatus: [],
    files: scanWorkspaceFiles(root),
  };

  if (isGitRepo) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (branch.ok) snapshot.branch = branch.stdout;
    const head = git(['rev-parse', 'HEAD'], root);
    if (head.ok) snapshot.headCommit = head.stdout;
    const status = git(['status', '--porcelain'], root);
    if (status.ok) {
      snapshot.gitStatus = status.stdout === '' ? [] : status.stdout.split('\n');
    }
  }

  return snapshot;
}

/** Compute what the human changed between two snapshots. */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff {
  const beforeMap = new Map(before.files.map((f) => [f.path, f]));
  const afterMap = new Map(after.files.map((f) => [f.path, f]));

  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, af] of afterMap) {
    const bf = beforeMap.get(path);
    if (!bf) {
      created.push(path);
    } else if (bf.size !== af.size || bf.mtimeMs !== af.mtimeMs) {
      modified.push(path);
    }
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) deleted.push(path);
  }

  const beforeStatus = new Set(before.gitStatus);
  const gitStatusAdded = after.gitStatus.filter((line) => !beforeStatus.has(line));

  return { created, modified, deleted, gitStatusAdded };
}

export function allChangedPaths(diff: WorkspaceDiff): string[] {
  return [...new Set([...diff.created, ...diff.modified, ...diff.deleted])].sort();
}
