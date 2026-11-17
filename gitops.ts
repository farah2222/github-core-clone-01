// Git-level operations shared by the REST contents API, the git smart-HTTP surface,
// GraphQL and MCP: resolving refs, reading/writing file trees, listing commits,
// diffing trees (pull-request files) and squash-merging.
//
// Every file change the suite makes — whether through a git push or through REST
// PUT /contents — lands in the same object store, so both surfaces always agree.

import {
  buildCommit,
  buildTree,
  collectReachable,
  getObject,
  parseCommit,
  parseTree,
  putObject,
  type TreeEntry,
} from './git.ts';
import {
  hashObject,
  nowIso,
  userFor,
  ZERO_OID,
  type Issue,
  type PullFile,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// refs
// -------------------------------------------------------------------------------------------

/** Resolve a ref-ish to a commit oid: "main", "refs/heads/main", a full ref name, or a 40-hex oid. */
export function resolveRef(repo: Repo, ref: string | undefined): string | undefined {
  if (!ref) return repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch) return asBranch;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref)) return ref.toLowerCase();
  return undefined;
}

/** The tip commit oid of a branch name, or undefined when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Identity line for commits the forge itself authors ("Name <email> <unix> +0000"). */
export function identity(store: Store, when: Date = new Date()): string {
  const login = store.viewer ?? 'forge';
  const user = userFor(store, login);
  return `${user.name} <${user.email}> ${Math.floor(when.getTime() / 1000)} +0000`;
}

// -------------------------------------------------------------------------------------------
// trees
// -------------------------------------------------------------------------------------------

/** Flatten a tree (recursively) to path -> { sha, mode }. */
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const obj = getObject(repo, treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.sha, path)) out.set(p, v);
    } else {
      out.set(path, { sha: e.sha, mode: e.mode });
    }
  }
  return out;
}

/** Read one path at a commit: file bytes, or a directory's entries. */
export function readPath(
  repo: Repo,
  commitSha: string,
  path: string,
): { kind: 'file'; sha: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | undefined {
  const commit = getObject(repo, commitSha);
  if (!commit || commit.type !== 'commit') return undefined;
  const treeSha = parseCommit(commit.data).tree;
  const parts = path.split('/').filter((p) => p !== '');
  let cur = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') {
        const dir = getObject(repo, entry.sha);
        return dir && dir.type === 'tree' ? { kind: 'dir', entries: parseTree(dir.data) } : undefined;
      }
      const blob = getObject(repo, entry.sha);
      return blob ? { kind: 'file', sha: entry.sha, data: blob.data } : undefined;
    }
    if (entry.mode !== '40000') return undefined;
    cur = entry.sha;
  }
  // Empty path = the root tree.
  const root = getObject(repo, cur);
  return root && root.type === 'tree' ? { kind: 'dir', entries: parseTree(root.data) } : undefined;
}

/** Return a new tree oid with `path` set to `blobSha` (or removed when null). Creates intermediate trees. */
export function setPathInTree(
  repo: Repo,
  treeSha: string | null,
  parts: string[],
  blobSha: string | null,
  mode = '100644',
): string {
  if (parts.length === 0) return treeSha ?? putObject(repo, 'tree', buildTree([]));
  const entries: TreeEntry[] = treeSha ? parseTree(getObject(repo, treeSha)?.data ?? Buffer.alloc(0)) : [];
  const [head, ...rest] = parts;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobSha === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode, name: head, sha: blobSha };
    } else {
      entries.push({ mode, name: head, sha: blobSha });
    }
  } else {
    const childTree = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].sha : null;
    const newChild = setPathInTree(repo, childTree, rest, blobSha, mode);
    const childObj = getObject(repo, newChild);
    const isEmpty = childObj && childObj.type === 'tree' && childObj.data.length === 0;
    if (isEmpty && blobSha === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, sha: newChild };
    } else {
      entries.push({ mode: '40000', name: head, sha: newChild });
    }
  }
  return putObject(repo, 'tree', buildTree(entries));
}

/** The empty tree oid (shared constant, computed once per repo on first use). */
export function emptyTree(repo: Repo): string {
  return putObject(repo, 'tree', buildTree([]));
}

// -------------------------------------------------------------------------------------------
// commits
// -------------------------------------------------------------------------------------------

export interface CommitRecord {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

/** Parse a stored commit object into a record. */
export function readCommit(repo: Repo, sha: string): CommitRecord | undefined {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return undefined;
  const info = parseCommit(obj.data);
  return { sha, tree: info.tree, parents: info.parents, message: info.message, author: info.author, committer: info.committer };
}

/** Create a commit object on top of `treeSha` (parents may be empty) and store it. */
export function makeCommit(
  store: Store,
  repo: Repo,
  treeSha: string,
  parents: string[],
  message: string,
): string {
  const when = new Date();
  const id = identity(store, when);
  const data = buildCommit(treeSha, parents, id, id, message.endsWith('\n') ? message : `${message}\n`);
  return putObject(repo, 'commit', data);
}

/**
 * Write one file on a branch (creating the branch and/or the repo's first commit when needed).
 * Returns the new commit oid and the blob oid.
 */
export function writeFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  data: Buffer,
  message: string,
): { commit: string; blob: string } {
  // A branch that does not exist yet starts from the default branch tip (GitHub behaviour);
  // only a repo with no commits at all starts a root commit.
  const tip = branchTip(repo, branch) ?? (branch !== repo.default_branch ? branchTip(repo, repo.default_branch) : undefined);
  const blob = putObject(repo, 'blob', data);
  const baseTree = tip ? readCommit(repo, tip)?.tree ?? null : null;
  const tree = setPathInTree(repo, baseTree, path.split('/').filter((p) => p !== ''), blob);
  const commit = makeCommit(store, repo, tree, tip ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { commit, blob };
}

/** Delete one file on a branch. Returns the new commit oid, or undefined when the path is absent. */
export function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): string | undefined {
  const tip = branchTip(repo, branch);
  if (!tip) return undefined;
  const record = readCommit(repo, tip);
  if (!record) return undefined;
  if (!readPath(repo, tip, path) || readPath(repo, tip, path)?.kind !== 'file') return undefined;
  const tree = setPathInTree(repo, record.tree, path.split('/').filter((p) => p !== ''), null);
  const commit = makeCommit(store, repo, tree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

/** First-parent history of a ref, newest first. */
export function listCommits(repo: Repo, ref: string | undefined, limit = 100): CommitRecord[] {
  const tip = resolveRef(repo, ref);
  if (!tip) return [];
  const out: CommitRecord[] = [];
  let cur: string | undefined = tip;
  const seen = new Set<string>();
  while (cur && cur !== ZERO_OID && !seen.has(cur) && out.length < limit) {
    seen.add(cur);
    const record = readCommit(repo, cur);
    if (!record) break;
    out.push(record);
    cur = record.parents[0];
  }
  return out;
}

/** All ancestors of `sha` (every parent, not just first), as a set. */
export function ancestors(repo: Repo, sha: string): Set<string> {
  const out = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ZERO_OID || out.has(cur)) continue;
    out.add(cur);
    const record = readCommit(repo, cur);
    if (record) for (const p of record.parents) stack.push(p);
  }
  return out;
}

/** True when `oldSha` is an ancestor of (or equal to) `newSha`. */
export function isAncestor(repo: Repo, oldSha: string, newSha: string): boolean {
  if (oldSha === newSha) return true;
  return ancestors(repo, newSha).has(oldSha);
}

/** The merge-base of two commits: the first common ancestor found walking `b`'s history. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const aAncestors = ancestors(repo, a);
  const stack = [b];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ZERO_OID || seen.has(cur)) continue;
    seen.add(cur);
    if (aAncestors.has(cur)) return cur;
    const record = readCommit(repo, cur);
    if (record) for (const p of record.parents) stack.push(p);
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// diffs and merges (pull requests)
// -------------------------------------------------------------------------------------------

/** Split text into lines for the line diff (binary-safe: falls back to whole-blob compare). */
function splitLines(data: Buffer): string[] | null {
  if (data.includes(0)) return null;
  return data.toString('utf8').split('\n');
}

/** Count added/removed lines between two blobs with a simple LCS (files here are small). */
export function countLineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a === null || b === null) return { additions: before.equals(after) ? 0 : 1, deletions: before.equals(after) ? 0 : 1 };
  // LCS dynamic programming over lines (bounded: blobs in this suite are <= ~20 KiB).
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Too big for DP: approximate by multiset difference.
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const c = counts.get(line) ?? 0;
      if (c > 0) {
        counts.set(line, c - 1);
        common += 1;
      }
    }
    return { additions: m - common, deletions: n - common };
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

/** Diff two trees into GitHub-style pull-request file entries. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): PullFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const data = getObject(repo, b.sha)?.data ?? Buffer.alloc(0);
      const lines = splitLines(data);
      const deletions = lines === null ? 1 : lines.length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const data = getObject(repo, h.sha)?.data ?? Buffer.alloc(0);
      const lines = splitLines(data);
      const additions = lines === null ? 1 : lines.length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.sha !== h.sha) {
      const before = getObject(repo, b.sha)?.data ?? Buffer.alloc(0);
      const after = getObject(repo, h.sha)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = countLineDiff(before, after);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Compute a PR's file list from its head and base branch tips (merge-base as the diff base). */
export function pullFiles(repo: Repo, pr: PullRequest): PullFile[] {
  const headTip = branchTip(repo, pr.head.ref);
  const baseTip = branchTip(repo, pr.base.ref);
  if (!headTip || !baseTip) return pr.files;
  const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseRecord = readCommit(repo, base);
  const headRecord = readCommit(repo, headTip);
  if (!baseRecord || !headRecord) return pr.files;
  return diffTrees(repo, baseRecord.tree, headRecord.tree);
}

/** Refresh a PR's stored file list (called on read, so merges/updates stay current). */
export function refreshPullFiles(repo: Repo, pr: PullRequest): PullRequest {
  pr.files = pullFiles(repo, pr);
  return pr;
}

/**
 * Squash-merge a pull request onto its base branch: apply the head's changes (diffed against
 * the merge-base) onto the base tip. Returns the merge commit oid, or null on conflict.
 */
export function squashMerge(store: Store, repo: Repo, pr: PullRequest): string | null {
  const headTip = branchTip(repo, pr.head.ref);
  const baseTip = branchTip(repo, pr.base.ref);
  if (!headTip || !baseTip) return null;
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return null;
  const baseRecord = readCommit(repo, base);
  const headRecord = readCommit(repo, headTip);
  const baseTipRecord = readCommit(repo, baseTip);
  if (!baseRecord || !headRecord || !baseTipRecord) return null;

  const baseFlat = flattenTree(repo, baseRecord.tree);
  const headFlat = flattenTree(repo, headRecord.tree);
  const tipFlat = flattenTree(repo, baseTipRecord.tree);

  // Three-way apply: for every path the head changed vs the merge-base, the base tip must
  // still hold the merge-base version (or already hold the head version); otherwise conflict.
  let tree = baseTipRecord.tree;
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    const headChanged = (b?.sha ?? null) !== (h?.sha ?? null);
    if (!headChanged) continue;
    const tipMatchesBase = (t?.sha ?? null) === (b?.sha ?? null);
    const tipMatchesHead = (t?.sha ?? null) === (h?.sha ?? null);
    if (!tipMatchesBase && !tipMatchesHead) return null; // both sides changed it differently
    if (tipMatchesHead) continue; // already applied
    tree = setPathInTree(repo, tree, path.split('/'), h ? h.sha : null, h?.mode ?? '100644');
  }
  const message = `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}`;
  const commit = makeCommit(store, repo, tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pr.base.ref}`, commit);
  return commit;
}

// -------------------------------------------------------------------------------------------
// reachability helpers for fetch
// -------------------------------------------------------------------------------------------

/**
 * Collect objects reachable from `roots` up to `maxDepth` commits deep (tip = depth 1).
 * `maxDepth` Infinity means the whole closure. Returns the objects plus the set of commit
 * oids that sit exactly on the depth boundary (the shallow boundary) and the commit oids
 * that were fully included with their parents (for unshallow reporting).
 */
export function collectDepthLimited(
  repo: Repo,
  roots: string[],
  maxDepth: number,
): { objects: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>; boundary: Set<string> } {
  const objects = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  const boundary = new Set<string>();
  // Walk commits breadth-first by depth, collecting trees/blobs as we go.
  const queue: Array<{ sha: string; depth: number }> = [];
  const seenCommit = new Set<string>();
  for (const root of roots) {
    const obj = getObject(repo, root);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.set(root, obj);
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) queue.push({ sha: m[1], depth: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ sha: root, depth: 1 });
    }
  }
  while (queue.length > 0) {
    const { sha, depth } = queue.shift()!;
    if (seenCommit.has(sha)) continue;
    seenCommit.add(sha);
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') continue;
    objects.set(sha, obj);
    const info = parseCommit(obj.data);
    // The commit's tree and blobs are always included, at any depth.
    const treeStack = [info.tree];
    while (treeStack.length > 0) {
      const treeSha = treeStack.pop()!;
      const treeObj = getObject(repo, treeSha);
      if (!treeObj || objects.has(treeSha)) continue;
      objects.set(treeSha, treeObj);
      if (treeObj.type === 'tree') {
        for (const e of parseTree(treeObj.data)) {
          if (e.mode === '40000') treeStack.push(e.sha);
          else {
            const blob = getObject(repo, e.sha);
            if (blob) objects.set(e.sha, blob);
          }
        }
      }
    }
    if (depth >= maxDepth) {
      if (info.parents.length > 0) boundary.add(sha);
      continue;
    }
    for (const p of info.parents) queue.push({ sha: p, depth: depth + 1 });
  }
  return { objects, boundary };
}

/** The full reachable closure of `roots` (depth unlimited). */
export function reachableObjects(repo: Repo, roots: string[]): Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> {
  return collectReachable(repo, roots, []);
}

/** SHA-1 of a blob's bytes, as git computes it (used for the contents API). */
export function blobSha(data: Buffer): string {
  return hashObject('blob', data);
}

export type { Issue };
export { nowIso };
