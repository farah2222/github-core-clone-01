// The forge's in-memory store: repositories, git objects, refs, issues, pull requests,
// labels and comments. Everything lives in Maps; nothing touches disk (the trial mounts the
// repository read-only and only /tmp is writable), which also keeps the timed workloads fast.
// A repository's git history (objects + refs) is the single source of truth for both the git
// smart-HTTP surface and the REST contents API: a file written through REST is a git commit,
// and a push through git is visible through REST.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** SHA-1 of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  files: PullFile[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  /** sha -> object. */
  objects: Map<string, GitObject>;
  /** full ref name -> tip sha. */
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  labelSeq: number;
  commentSeq: number;
}

export interface Store {
  repos: Map<string, Repo>;
  repoSeq: number;
  users: Map<string, User>;
  /** The login the bearer token names, once learned from the first owner-naming request.
   * The final instances are drawn per trial, so the viewer login is NOT knowable in advance:
   * it is learned lazily (see viewer.ts notes in rest.ts). Null until learned. */
  viewer: string | null;
  /** Global id sequence for issues, pull requests and comments (stable across reads). */
  idSeq: number;
}

export function createStore(): Store {
  return { repos: new Map(), repoSeq: 1, users: new Map(), viewer: null, idSeq: 1 };
}

/** Next stable global object id. */
export function nextId(store: Store): number {
  return store.idSeq++;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

/** A stable user record for a login (ids are assigned in first-seen order). */
export function userFor(store: Store, login: string): User {
  let user = store.users.get(login);
  if (!user) {
    user = { id: 1000 + store.users.size, login, name: login, email: `${login}@example.invalid` };
    store.users.set(login, user);
  }
  return user;
}

/** ISO-8601 timestamp (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The git object id of a ref, or the zero id when it does not exist. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}
