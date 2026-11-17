// REST v3 surface (/api/v3). All replies are JSON with a non-empty X-GitHub-Request-Id
// (added by app.ts). Errors carry {"message": <non-empty string>}.
//
// Viewer learning: the final instances are drawn per trial, so the login the bearer token
// names is NOT knowable in advance (no hardcoded login anywhere). The viewer is learned
// lazily from the first authenticated request that names an owner, and repositories created
// through POST /user/repos start owner-less ("unbound") until that first owner-naming
// request binds them. The foreign-owner rule then falls out naturally: a repo bound to the
// viewer 404s for any other owner. GET /user answers 404 until the viewer is learned, which
// the MCP setup tolerates (it falls back to its own scenario login, and the very next
// repo round-trip binds the viewer).

import {
  branchTip,
  deleteFile,
  listCommits,
  readPath,
  refreshPullFiles,
  resolveRef,
  squashMerge,
  writeFile,
  type CommitRecord,
} from './gitops.ts';
import {
  nextId,
  nowIso,
  userFor,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface Ctx {
  store: Store;
  method: string;
  /** Full request pathname (e.g. "/api/v3/user/repos"), for building same-origin links. */
  path: string;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  host: string;
}

export interface Reply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): Reply {
  return { status, json, headers };
}

function err(status: number, message: string): Reply {
  return { status, json: { message } };
}

const SHA40 = /^[0-9a-f]{40}$/i;

// -------------------------------------------------------------------------------------------
// viewer + repo resolution
// -------------------------------------------------------------------------------------------

/** Learn the viewer login from an owner seen on an authenticated request. */
export function learnViewer(store: Store, owner: string): void {
  if (store.viewer === null && owner !== '') store.viewer = owner;
}

/** Bind an unbound repo to an owner (and learn the viewer from it). */
function bindRepo(store: Store, repo: Repo, owner: string): void {
  if (repo.owner === '') repo.owner = owner;
  learnViewer(store, owner);
}

export type RepoLookup =
  | { status: 'ok'; repo: Repo }
  | { status: 'not-found' }
  | { status: 'foreign' };

/** Find a repo by name, honouring the foreign-owner rule (404, never 403). */
export function lookupRepo(store: Store, owner: string, name: string): RepoLookup {
  const repo = store.repos.get(name);
  if (!repo) return { status: 'not-found' };
  if (repo.owner === '') {
    bindRepo(store, repo, owner);
    return { status: 'ok', repo };
  }
  if (repo.owner !== owner) return { status: 'foreign' };
  return { status: 'ok', repo };
}

function notFoundRepo(): Reply {
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// JSON body parsing
// -------------------------------------------------------------------------------------------

export function parseJsonBody(ctx: Ctx): { ok: true; value: Record<string, unknown> } | { ok: false; reply: Reply } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false, reply: err(400, 'Request body must be a JSON object') };
  } catch {
    return { ok: false, reply: err(400, 'Malformed JSON in request body') };
  }
}

function bodyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bodyBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// -------------------------------------------------------------------------------------------
// serializers
// -------------------------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner !== '' ? repo.owner : (store.viewer ?? '');
  const user = userFor(store, owner === '' ? 'forge' : owner);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, id: user.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://github.com/${owner}/${repo.name}`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments.length,
  };
}

function commentJson(comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = branchTip(repo, pr.head.ref) ?? pr.head.sha;
  const baseSha = branchTip(repo, pr.base.ref) ?? pr.base.sha;
  const owner = repo.owner !== '' ? repo.owner : (store.viewer ?? '');
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merge_commit_sha: pr.merge_commit_sha,
    merged_at: pr.merged_at,
    head: { ref: pr.head.ref, sha: headSha, label: `${owner}:${pr.head.ref}` },
    base: { ref: pr.base.ref, sha: baseSha, label: `${owner}:${pr.base.ref}` },
    user: { login: pr.user.login, id: pr.user.id, type: 'User' },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  };
}

function commitJson(store: Store, record: CommitRecord): Record<string, unknown> {
  const author = userFor(store, store.viewer ?? 'forge');
  return {
    sha: record.sha,
    commit: {
      message: record.message,
      author: { name: author.name, email: author.email, date: nowIso() },
      committer: { name: author.name, email: author.email, date: nowIso() },
    },
    author: { login: author.login, id: author.id, type: 'User' },
    committer: { login: author.login, id: author.id, type: 'User' },
  };
}

/** Page query params: per_page (default 30, clamp 1..100), page (default 1). */
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** Slice a list into a page and build a GitHub-style Link header (same-origin URLs only). */
function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(ctx.query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const base = `http://${ctx.host}${ctx.path}`;
  const links: string[] = [];
  const other = new URLSearchParams(ctx.query);
  other.set('per_page', String(perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(other);
    q.set('page', String(p));
    return `${base}?${q.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: pageItems, link: links.length > 0 ? links.join(', ') : null };
}

// -------------------------------------------------------------------------------------------
// shared record builders (used by REST, GraphQL and MCP so all three see the same objects)
// -------------------------------------------------------------------------------------------

/** Create a repository record. Returns null when the name is empty or already taken. */
export function createRepoRecord(store: Store, name: string, isPrivate: boolean, description: string): Repo | null {
  if (name === '' || store.repos.has(name)) return null;
  const repo: Repo = {
    id: store.repoSeq++,
    owner: store.viewer ?? '',
    name,
    full_name: store.viewer ? `${store.viewer}/${name}` : name,
    description,
    private: isPrivate,
    default_branch: 'main',
    created_at: nowIso(),
    updated_at: nowIso(),
    objects: new Map(),
    refs: new Map(),
    labels: [],
    issues: [],
    pulls: [],
    issueSeq: 0,
    pullSeq: 0,
    labelSeq: 0,
    commentSeq: 0,
  };
  store.repos.set(name, repo);
  return repo;
}

/** Create an issue record on a repo (labels must already be resolved). */
export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const issue: Issue = {
    id: nextId(store),
    number: ++repo.issueSeq,
    title,
    body,
    state: 'open',
    labels,
    user: userFor(store, store.viewer ?? 'forge'),
    created_at: nowIso(),
    updated_at: nowIso(),
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

/** Create a pull-request record. Returns null when either branch tip is missing. */
export function createPullRecord(store: Store, repo: Repo, head: string, base: string, title: string, body: string): PullRequest | null {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (!headSha || !baseSha) return null;
  const owner = repo.owner !== '' ? repo.owner : (store.viewer ?? '');
  const pr: PullRequest = {
    id: nextId(store),
    number: ++repo.pullSeq,
    title,
    body,
    state: 'open',
    head: { ref: head, sha: headSha, label: `${owner}:${head}` },
    base: { ref: base, sha: baseSha, label: `${owner}:${base}` },
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    user: userFor(store, store.viewer ?? 'forge'),
    created_at: nowIso(),
    updated_at: nowIso(),
    files: [],
  };
  pr.files = refreshPullFiles(repo, pr).files;
  repo.pulls.push(pr);
  return pr;
}

// -------------------------------------------------------------------------------------------
// route handlers
// -------------------------------------------------------------------------------------------

function createRepo(store: Store, body: Record<string, unknown>): Reply {
  const name = bodyString(body.name);
  if (name === '') return err(422, 'Repository name is required');
  const repo = createRepoRecord(store, name, bodyBool(body.private, false), bodyString(body.description));
  if (!repo) return err(422, 'Repository already exists');
  return ok(201, repoJson(store, repo));
}

function listUserRepos(ctx: Ctx): Reply {
  const repos = [...ctx.store.repos.values()].sort((a, b) => a.id - b.id);
  const { page, link } = paginate(ctx, repos.map((r) => repoJson(ctx.store, r)));
  return ok(200, page, link ? { link } : undefined);
}

function getContents(ctx: Ctx, repo: Repo, pathParts: string[]): Reply {
  const ref = ctx.query.get('ref') ?? undefined;
  const tip = resolveRef(repo, ref);
  if (!tip) return err(404, 'Not Found');
  const path = pathParts.join('/');
  const found = readPath(repo, tip, path);
  if (!found) return err(404, 'Not Found');
  if (found.kind === 'file') {
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: found.data.length,
      name: pathParts[pathParts.length - 1] ?? '',
      path,
      content: found.data.toString('base64'),
      sha: found.sha,
    });
  }
  const items = found.entries.map((e) => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: e.name,
    path: path === '' ? e.name : `${path}/${e.name}`,
    sha: e.sha,
    size: 0,
  }));
  return ok(200, items);
}

function putContents(ctx: Ctx, repo: Repo, pathParts: string[], body: Record<string, unknown>): Reply {
  const path = pathParts.join('/');
  if (path === '') return err(422, 'A file path is required');
  const contentB64 = bodyString(body.content);
  if (contentB64 === '') return err(422, 'content is required');
  let data: Buffer;
  try {
    data = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'content must be base64');
  }
  const branch = bodyString(body.branch) || repo.default_branch;
  const message = bodyString(body.message) || `Update ${path}`;
  const tip = branchTip(repo, branch) ?? branchTip(repo, repo.default_branch);
  const existing = tip ? readPath(repo, tip, path) : undefined;
  const givenSha = bodyString(body.sha);
  if (existing && existing.kind === 'file') {
    if (givenSha === '') return err(422, 'sha is required to update a file');
    if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    const { commit, blob } = writeFile(ctx.store, repo, branch, path, data, message);
    return ok(200, {
      content: { name: pathParts[pathParts.length - 1], path, sha: blob, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit, message },
    });
  }
  if (existing && existing.kind === 'dir') return err(422, 'path is a directory');
  const { commit, blob } = writeFile(ctx.store, repo, branch, path, data, message);
  return ok(201, {
    content: { name: pathParts[pathParts.length - 1], path, sha: blob, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit, message },
  });
}

function deleteContents(ctx: Ctx, repo: Repo, pathParts: string[], body: Record<string, unknown>): Reply {
  const path = pathParts.join('/');
  const branch = bodyString(body.branch) || repo.default_branch;
  const tip = branchTip(repo, branch);
  if (!tip) return err(404, 'Not Found');
  const existing = readPath(repo, tip, path);
  if (!existing || existing.kind !== 'file') return err(404, 'Not Found');
  const givenSha = bodyString(body.sha);
  if (givenSha !== '' && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
    return err(409, 'sha does not match the current file');
  }
  const commit = deleteFile(ctx.store, repo, branch, path, bodyString(body.message) || `Delete ${path}`);
  if (!commit) return err(404, 'Not Found');
  return ok(200, { commit: { sha: commit, message: bodyString(body.message) || `Delete ${path}` } });
}

function createIssue(ctx: Ctx, repo: Repo, body: Record<string, unknown>): Reply {
  const title = bodyString(body.title);
  if (title === '') return err(422, 'title is required');
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.find((l) => l.name === name);
    if (!label) return err(422, `Label does not exist: ${name}`);
    labels.push(label);
  }
  const issue = createIssueRecord(ctx.store, repo, title, bodyString(body.body), labels);
  return ok(201, issueJson(ctx.store, repo, issue));
}

function listIssues(ctx: Ctx, repo: Repo): Reply {
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  let items = [...repo.issues];
  if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
  if (sort === 'created') {
    items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { page, link } = paginate(ctx, items.map((i) => issueJson(ctx.store, repo, i)));
  return ok(200, page, link ? { link } : undefined);
}

function createPull(ctx: Ctx, repo: Repo, body: Record<string, unknown>): Reply {
  const head = bodyString(body.head);
  const base = bodyString(body.base);
  const title = bodyString(body.title);
  if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
  const pr = createPullRecord(ctx.store, repo, head, base, title, bodyString(body.body));
  if (!pr) return err(422, 'Head or base branch not found');
  return ok(201, pullJson(ctx.store, repo, pr));
}

function listPulls(ctx: Ctx, repo: Repo): Reply {
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  let items = [...repo.pulls];
  if (state === 'open' || state === 'closed') items = items.filter((p) => p.state === state);
  items.sort((a, b) => b.number - a.number);
  const { page, link } = paginate(ctx, items.map((p) => pullJson(ctx.store, repo, p)));
  return ok(200, page, link ? { link } : undefined);
}

function mergePull(ctx: Ctx, repo: Repo, pr: PullRequest): Reply {
  if (pr.merged) return err(405, 'Pull request already merged');
  const sha = squashMerge(ctx.store, repo, pr);
  if (sha === null) return err(405, 'Merge conflict');
  pr.merged = true;
  pr.state = 'closed';
  pr.merge_commit_sha = sha;
  pr.merged_at = nowIso();
  pr.updated_at = nowIso();
  return ok(200, { merged: true, sha, message: `Pull request #${pr.number} merged` });
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

/** Handle a request under /api/v3. Returns null when the path is not a REST route. */
export async function handleRest(ctx: Ctx): Promise<Reply | null> {
  const { store, method, segments: s } = ctx;
  const jsonBody = async (): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reply: Reply }> =>
    parseJsonBody(ctx);

  // API root and meta (no auth needed, like api.github.com).
  if (s.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }

  // GET /user (viewer). 404 until the viewer is learned; MCP setup falls back then.
  if (s.length === 1 && s[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    if (store.viewer === null) return err(404, 'Viewer not resolved');
    const user = userFor(store, store.viewer);
    return ok(200, { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User' });
  }

  // POST /user/repos and GET /user/repos.
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await jsonBody();
      if (!parsed.ok) return parsed.reply;
      return createRepo(store, parsed.value);
    }
    if (method === 'GET') return listUserRepos(ctx);
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}/...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeURIComponent(s[1]);
    const name = decodeURIComponent(s[2]);
    const rest = s.slice(3);
    const lookup = lookupRepo(store, owner, name);
    if (lookup.status !== 'ok') return notFoundRepo();
    const repo = lookup.repo;

    // /repos/{o}/{r} itself.
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const parsed = await jsonBody();
        if (!parsed.ok) return parsed.reply;
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        repo.updated_at = nowIso();
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.repos.delete(name);
        return { status: 204, json: null, empty: true };
      }
      return err(404, 'Not Found');
    }

    // git refs: POST /git/refs, GET /git/refs[/heads/{branch}].
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = await jsonBody();
        if (!parsed.ok) return parsed.reply;
        const ref = bodyString(parsed.value.ref);
        const sha = bodyString(parsed.value.sha);
        if (!ref.startsWith('refs/') || !SHA40.test(sha)) return err(422, 'ref and sha are required');
        repo.refs.set(ref, sha.toLowerCase());
        return ok(201, { ref, object: { sha: sha.toLowerCase() } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          return ok(200, [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } })));
        }
        if (rest.length === 4 && rest[2] === 'heads') {
          const sha = branchTip(repo, decodeURIComponent(rest[3]));
          if (!sha) return err(404, 'Not Found');
          return ok(200, { ref: `refs/heads/${decodeURIComponent(rest[3])}`, object: { sha } });
        }
      }
      return err(404, 'Not Found');
    }

    // GET /branches and GET /branches/{branch}.
    if (rest[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      if (rest.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return ok(200, branches);
      }
      if (rest.length === 2) {
        const sha = branchTip(repo, decodeURIComponent(rest[1]));
        if (!sha) return err(404, 'Not Found');
        return ok(200, { name: decodeURIComponent(rest[1]), commit: { sha } });
      }
      return err(404, 'Not Found');
    }

    // GET /commits[?sha=ref].
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const ref = ctx.query.get('sha') ?? undefined;
      const records = listCommits(repo, ref);
      return ok(200, records.map((r) => commitJson(store, r)));
    }

    // Contents: PUT/GET/DELETE /contents/{path...}.
    if (rest[0] === 'contents') {
      const pathParts = rest.slice(1).map((p) => decodeURIComponent(p));
      if (method === 'GET') return getContents(ctx, repo, pathParts);
      if (method === 'PUT') {
        const parsed = await jsonBody();
        if (!parsed.ok) return parsed.reply;
        return putContents(ctx, repo, pathParts, parsed.value);
      }
      if (method === 'DELETE') {
        const parsed = await jsonBody();
        if (!parsed.ok) return parsed.reply;
        return deleteContents(ctx, repo, pathParts, parsed.value);
      }
      return err(404, 'Not Found');
    }

    // Labels.
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') {
        const parsed = await jsonBody();
        if (!parsed.ok) return parsed.reply;
        const labelName = bodyString(parsed.value.name);
        if (labelName === '') return err(422, 'name is required');
        if (repo.labels.some((l) => l.name === labelName)) return err(422, 'Label already exists');
        const label: Label = {
          id: ++repo.labelSeq,
          name: labelName,
          color: bodyString(parsed.value.color) || 'ededed',
          description: bodyString(parsed.value.description),
        };
        repo.labels.push(label);
        return ok(201, labelJson(label));
      }
      if (method === 'GET') return ok(200, repo.labels.map(labelJson));
      return err(404, 'Not Found');
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = await jsonBody();
          if (!parsed.ok) return parsed.reply;
          return createIssue(ctx, repo, parsed.value);
        }
        if (method === 'GET') return listIssues(ctx, repo);
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const parsed = await jsonBody();
          if (!parsed.ok) return parsed.reply;
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          issue.updated_at = nowIso();
          return ok(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'POST') {
          const parsed = await jsonBody();
          if (!parsed.ok) return parsed.reply;
          const comment = {
            id: nextId(store),
            body: bodyString(parsed.value.body),
            user: userFor(store, store.viewer ?? 'forge'),
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          issue.comments.push(comment);
          issue.updated_at = nowIso();
          return ok(201, commentJson(comment));
        }
        if (method === 'GET') return ok(200, issue.comments.map(commentJson));
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = await jsonBody();
          if (!parsed.ok) return parsed.reply;
          return createPull(ctx, repo, parsed.value);
        }
        if (method === 'GET') return listPulls(ctx, repo);
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const pr = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pr) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(store, repo, refreshPullFiles(repo, pr)));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, refreshPullFiles(repo, pr).files);
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pr) return err(404, 'Not Found');
        if (method === 'PUT') return mergePull(ctx, repo, pr);
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return null;
}
