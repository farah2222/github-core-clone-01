// GraphQL v4 surface (POST /api/graphql). A small purpose-built parser + executor for
// the documents the suite sends (see the kit's checks-graphql.ts): queries, mutations,
// variables, aliases, inline fragments, __type introspection, and batched operations.
// GraphQL-level failures are HTTP 200 with an `errors` array; only a missing/invalid
// bearer token is a 401 (handled by app.ts before this runs).
//
// Global ids are opaque base64 of "Type:<ids>" — never the raw number — and stable.

import {
  branchTip,
  pullFiles,
  refreshPullFiles,
  squashMerge,
} from './gitops.ts';
import { lookupRepo, type Ctx, type Reply } from './rest.ts';
import {
  nextId,
  nowIso,
  userFor,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// global ids
// -------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = Number.parseInt(decoded.parts[0], 10);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repoId = Number.parseInt(decoded.parts[0], 10);
  const number = Number.parseInt(decoded.parts[1], 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function pullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repoId = Number.parseInt(decoded.parts[0], 10);
  const number = Number.parseInt(decoded.parts[1], 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pr = repo.pulls.find((p) => p.number === number);
    if (pr) return { repo, pr };
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// GraphQL document parsing (tokenizer + recursive descent)
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string; selection: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') {
        while (i < src.length && src[i] !== '\n') i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=[]{}|'.includes(c) || c === '@') {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected '${value}' but got '${t.value}'`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected a name but got '${t.value}'`);
    if (value !== undefined && t.value !== value) throw new Error(`Expected '${value}' but got '${t.value}'`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek()) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n?.kind === 'name') name = this.next().value;
    }
    // Variable definitions "(...)" — skipped (values come from the request's variables).
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipParens();
    const selection = this.parseSelectionSet();
    return { kind, name, selection };
  }

  private skipParens(): void {
    let depth = 0;
    while (this.peek()) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') {
        this.next();
        const type = this.expectName();
        return { kind: 'fragment', type, selection: this.parseSelectionSet() };
      }
      // Named fragment spread ("...Name"): not used by the suite; treat as empty.
      if (n?.kind === 'name') this.next();
      return { kind: 'fragment', type: '', selection: [] };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives "@name(...)" — skipped.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipParens();
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number.parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: Number.parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() && !(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token '${t.value}'`);
  }
}

// -------------------------------------------------------------------------------------------
// introspection data
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyObj =
  | { __type: 'User'; login: string; id: number }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: AnyObj }
  | { __type: 'PullRequestConnection'; repo: Repo; prs: PullRequest[] }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'Ref'; name: string }
  | { __type: 'Comment'; repo: Repo; issue: Issue; id: number; body: string }
  | { __type: 'CommentEdge'; node: AnyObj }
  | { __type: 'CreateIssuePayload'; issue: AnyObj | null }
  | { __type: 'CloseIssuePayload'; issue: AnyObj | null }
  | { __type: 'CreatePullRequestPayload'; pr: AnyObj | null }
  | { __type: 'MergePullRequestPayload'; pr: AnyObj | null }
  | { __type: 'AddCommentPayload'; edge: AnyObj | null }
  | { __type: 'TypeInfo'; name: string }
  | { __type: 'Root' };

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, state: ExecState): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg ? resolveValue(arg.value, state.variables) : undefined;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function prStateGql(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, issues: Issue[], first: number | undefined, after: string | null | undefined): AnyObj {
  // The caller supplies the order (e.g. CREATED_AT DESC); the connection only pages it.
  // `after` resumes after the cursor's issue, whatever the order.
  let list = [...issues];
  const afterNum = numberFromCursor(after);
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const total = list.length;
  const page = typeof first === 'number' ? list.slice(0, first) : list;
  const hasNextPage = total > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __type: 'IssueConnection',
    repo,
    issues: page,
    pageInfo: { __type: 'PageInfo', hasNextPage, endCursor },
  };
}

/** Execute a selection set against an object; returns the field map (null on fatal error). */
function executeSelection(state: ExecState, obj: AnyObj, selection: SelectionNode[] | undefined): Record<string, unknown> | null {
  if (!selection) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') {
      if (sel.type === '' || matchesType(obj, sel.type)) {
        const sub = executeSelection(state, obj, sel.selection);
        if (sub) Object.assign(out, sub);
      }
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    const value = resolveField(state, obj, field);
    out[key] = value;
  }
  return out;
}

function matchesType(obj: AnyObj, type: string): boolean {
  return obj.__type === type;
}

function unknownField(state: ExecState, objType: string, field: string): null {
  state.errors.push({ message: `Cannot query field "${field}" on type "${objType}".` });
  return null;
}

function resolveField(state: ExecState, obj: AnyObj, field: FieldNode): unknown {
  const { store } = state;
  switch (obj.__type) {
    case 'Root': {
      if (field.name === 'viewer') {
        const login = store.viewer ?? '';
        const user = userFor(store, login === '' ? 'forge' : login);
        return executeSelection(state, { __type: 'User', login, id: user.id }, field.selection);
      }
      if (field.name === 'repository') {
        const owner = String(argValue(field, 'owner', state) ?? '');
        const name = String(argValue(field, 'name', state) ?? '');
        const lookup = lookupRepo(store, owner, name);
        if (lookup.status !== 'ok') return null;
        return executeSelection(state, { __type: 'Repository', repo: lookup.repo }, field.selection);
      }
      if (field.name === 'node') {
        const id = String(argValue(field, 'id', state) ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(store, id);
          if (!repo) return null;
          return executeSelection(state, { __type: 'Repository', repo }, field.selection);
        }
        if (decoded.kind === 'Issue') {
          const found = issueByGlobalId(store, id);
          if (!found) return null;
          return executeSelection(state, { __type: 'Issue', repo: found.repo, issue: found.issue }, field.selection);
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullByGlobalId(store, id);
          if (!found) return null;
          return executeSelection(state, { __type: 'PullRequest', repo: found.repo, pr: found.pr }, field.selection);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(argValue(field, 'name', state) ?? '');
        return executeSelection(state, { __type: 'TypeInfo', name }, field.selection);
      }
      if (field.name === 'createIssue') return executeSelection(state, doCreateIssue(state, field), field.selection);
      if (field.name === 'closeIssue') return executeSelection(state, doCloseIssue(state, field), field.selection);
      if (field.name === 'createPullRequest') return executeSelection(state, doCreatePullRequest(state, field), field.selection);
      if (field.name === 'mergePullRequest') return executeSelection(state, doMergePullRequest(state, field), field.selection);
      if (field.name === 'addComment') return executeSelection(state, doAddComment(state, field), field.selection);
      return unknownField(state, 'Query', field.name);
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return globalId('User', obj.id);
      if (field.name === 'name') return obj.login;
      if (field.name === 'email') return `${obj.login}@example.invalid`;
      return unknownField(state, 'User', field.name);
    }
    case 'Repository': {
      const repo = obj.repo;
      if (field.name === 'id') return globalId('Repository', repo.id);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.owner !== '' ? `${repo.owner}/${repo.name}` : repo.name;
      if (field.name === 'description') return repo.description;
      if (field.name === 'private') return repo.private;
      if (field.name === 'owner') {
        const user = userFor(store, repo.owner !== '' ? repo.owner : (store.viewer ?? 'forge'));
        return executeSelection(state, { __type: 'User', login: repo.owner, id: user.id }, field.selection);
      }
      if (field.name === 'defaultBranchRef') {
        return executeSelection(state, { __type: 'Ref', name: repo.default_branch }, field.selection);
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = Number(argValue(field, 'number', state));
        const issue = repo.issues.find((i) => i.number === number);
        if (!issue) return null;
        return executeSelection(state, { __type: 'Issue', repo, issue }, field.selection);
      }
      if (field.name === 'issues') {
        const first = argValue(field, 'first', state) as number | undefined;
        const after = argValue(field, 'after', state) as string | null | undefined;
        const states = argValue(field, 'states', state) as string[] | undefined;
        const orderBy = argValue(field, 'orderBy', state) as { field?: string; direction?: string } | undefined;
        let list = [...repo.issues];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          list = list.filter((i) => wanted.has(issueStateGql(i.state)));
        }
        if (orderBy?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
        else if (orderBy?.direction === 'ASC') list.sort((a, b) => a.number - b.number);
        else list.sort((a, b) => a.number - b.number);
        return executeSelection(state, issueConnection(repo, list, first, after), field.selection);
      }
      if (field.name === 'pullRequest') {
        const number = Number(argValue(field, 'number', state));
        const pr = repo.pulls.find((p) => p.number === number);
        if (!pr) return null;
        return executeSelection(state, { __type: 'PullRequest', repo, pr }, field.selection);
      }
      if (field.name === 'pullRequests') {
        const first = argValue(field, 'first', state) as number | undefined;
        const list = [...repo.pulls].sort((a, b) => b.number - a.number);
        const page = typeof first === 'number' ? list.slice(0, first) : list;
        return executeSelection(
          state,
          { __type: 'PullRequestConnection', repo, prs: page },
          field.selection,
        );
      }
      return unknownField(state, 'Repository', field.name);
    }
    case 'Issue': {
      const issue = obj.issue;
      if (field.name === 'id') return globalId('Issue', obj.repo.id, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issueStateGql(issue.state);
      if (field.name === 'createdAt') return issue.created_at;
      if (field.name === 'updatedAt') return issue.updated_at;
      if (field.name === 'author') {
        return executeSelection(state, { __type: 'User', login: issue.user.login, id: issue.user.id }, field.selection);
      }
      if (field.name === 'repository') {
        return executeSelection(state, { __type: 'Repository', repo: obj.repo }, field.selection);
      }
      return unknownField(state, 'Issue', field.name);
    }
    case 'PullRequest': {
      const pr = obj.pr;
      if (field.name === 'id') return globalId('PullRequest', obj.repo.id, pr.number);
      if (field.name === 'number') return pr.number;
      if (field.name === 'title') return pr.title;
      if (field.name === 'body') return pr.body;
      if (field.name === 'state') return prStateGql(pr);
      if (field.name === 'headRefName') return pr.head.ref;
      if (field.name === 'baseRefName') return pr.base.ref;
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'mergeable') return 'MERGEABLE';
      if (field.name === 'mergedAt') return pr.merged_at;
      if (field.name === 'createdAt') return pr.created_at;
      if (field.name === 'updatedAt') return pr.updated_at;
      if (field.name === 'author') {
        return executeSelection(state, { __type: 'User', login: pr.user.login, id: pr.user.id }, field.selection);
      }
      if (field.name === 'files') {
        const first = argValue(field, 'first', state) as number | undefined;
        const files = pullFiles(obj.repo, pr);
        const page = typeof first === 'number' ? files.slice(0, first) : files;
        const nodes = page.map((f) => ({ __type: 'PullRequestFile', path: f.filename }) as unknown as AnyObj);
        // Files connection: resolve nodes inline.
        const out: Record<string, unknown> = {};
        for (const sel of field.selection ?? []) {
          if (sel.kind === 'field' && sel.field.name === 'nodes') {
            out[sel.field.alias ?? 'nodes'] = nodes.map((n) => {
              const sub: Record<string, unknown> = {};
              for (const s2 of sel.field.selection ?? []) {
                if (s2.kind === 'field' && s2.field.name === 'path') sub[s2.field.alias ?? 'path'] = (n as unknown as { path: string }).path;
              }
              return sub;
            });
          }
        }
        return out;
      }
      return unknownField(state, 'PullRequest', field.name);
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return obj.issues.map((issue) =>
          executeSelection(state, { __type: 'Issue', repo: obj.repo, issue }, field.selection),
        );
      }
      if (field.name === 'pageInfo') {
        return executeSelection(state, obj.pageInfo, field.selection);
      }
      if (field.name === 'totalCount') return obj.issues.length;
      return unknownField(state, 'IssueConnection', field.name);
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return obj.prs.map((pr) =>
          executeSelection(state, { __type: 'PullRequest', repo: obj.repo, pr }, field.selection),
        );
      }
      if (field.name === 'totalCount') return obj.prs.length;
      return unknownField(state, 'PullRequestConnection', field.name);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return obj.endCursor;
      return unknownField(state, 'PageInfo', field.name);
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name;
      return unknownField(state, 'Ref', field.name);
    }
    case 'Comment': {
      if (field.name === 'id') return globalId('IssueComment', obj.repo.id, obj.issue.number, obj.id);
      if (field.name === 'body') return obj.body;
      return unknownField(state, 'IssueComment', field.name);
    }
    case 'CommentEdge': {
      if (field.name === 'node') return executeSelection(state, obj.node, field.selection);
      return unknownField(state, 'IssueCommentEdge', field.name);
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') {
        return obj.issue ? executeSelection(state, obj.issue, field.selection) : null;
      }
      return unknownField(state, 'CreateIssuePayload', field.name);
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        return obj.issue ? executeSelection(state, obj.issue, field.selection) : null;
      }
      return unknownField(state, 'CloseIssuePayload', field.name);
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') {
        return obj.pr ? executeSelection(state, obj.pr, field.selection) : null;
      }
      return unknownField(state, 'CreatePullRequestPayload', field.name);
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        return obj.pr ? executeSelection(state, obj.pr, field.selection) : null;
      }
      return unknownField(state, 'MergePullRequestPayload', field.name);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        return obj.edge ? executeSelection(state, obj.edge, field.selection) : null;
      }
      return unknownField(state, 'AddCommentPayload', field.name);
    }
    case 'TypeInfo': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'kind') return TYPE_FIELDS[obj.name] ? 'OBJECT' : 'ENUM';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[obj.name] ?? [];
        return names.map((n) =>
          executeSelection(state, { __type: 'TypeField', name: n } as unknown as AnyObj, field.selection),
        );
      }
      if (field.name === 'enumValues') {
        const names = ENUM_VALUES[obj.name] ?? [];
        return names.map((n) =>
          executeSelection(state, { __type: 'EnumValue', name: n } as unknown as AnyObj, field.selection),
        );
      }
      return unknownField(state, '__Type', field.name);
    }
    default: {
      // Synthetic leaf objects used by introspection (TypeField / EnumValue).
      const rec = obj as unknown as Record<string, unknown>;
      if (typeof rec[field.name] === 'string') return rec[field.name];
      return unknownField(state, (obj as { __type: string }).__type ?? 'Unknown', field.name);
    }
  }
}

// -------------------------------------------------------------------------------------------
// mutations
// -------------------------------------------------------------------------------------------

function inputArg(state: ExecState, field: FieldNode): Record<string, unknown> {
  const value = argValue(field, 'input', state);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function doCreateIssue(state: ExecState, field: FieldNode): AnyObj {
  const input = inputArg(state, field);
  const repo = repoByGlobalId(state.store, String(input.repositoryId ?? ''));
  if (!repo) return { __type: 'CreateIssuePayload', issue: null };
  const title = String(input.title ?? '');
  const issue: Issue = {
    id: nextId(state.store),
    number: ++repo.issueSeq,
    title,
    body: String(input.body ?? ''),
    state: 'open',
    labels: [],
    user: userFor(state.store, state.store.viewer ?? 'forge'),
    created_at: nowIso(),
    updated_at: nowIso(),
    comments: [],
  };
  repo.issues.push(issue);
  return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue } };
}

function doCloseIssue(state: ExecState, field: FieldNode): AnyObj {
  const input = inputArg(state, field);
  const found = issueByGlobalId(state.store, String(input.issueId ?? ''));
  if (!found) return { __type: 'CloseIssuePayload', issue: null };
  found.issue.state = 'closed';
  found.issue.updated_at = nowIso();
  return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo: found.repo, issue: found.issue } };
}

function doCreatePullRequest(state: ExecState, field: FieldNode): AnyObj {
  const input = inputArg(state, field);
  const repo = repoByGlobalId(state.store, String(input.repositoryId ?? ''));
  if (!repo) return { __type: 'CreatePullRequestPayload', pr: null };
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (!headSha || !baseSha) return { __type: 'CreatePullRequestPayload', pr: null };
  const owner = repo.owner !== '' ? repo.owner : (state.store.viewer ?? '');
  const pr: PullRequest = {
    id: nextId(state.store),
    number: ++repo.pullSeq,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    head: { ref: head, sha: headSha, label: `${owner}:${head}` },
    base: { ref: base, sha: baseSha, label: `${owner}:${base}` },
    merged: false,
    merge_commit_sha: null,
    merged_at: null,
    user: userFor(state.store, state.store.viewer ?? 'forge'),
    created_at: nowIso(),
    updated_at: nowIso(),
    files: [],
  };
  pr.files = refreshPullFiles(repo, pr).files;
  repo.pulls.push(pr);
  return { __type: 'CreatePullRequestPayload', pr: { __type: 'PullRequest', repo, pr } };
}

function doMergePullRequest(state: ExecState, field: FieldNode): AnyObj {
  const input = inputArg(state, field);
  const found = pullByGlobalId(state.store, String(input.pullRequestId ?? ''));
  if (!found) return { __type: 'MergePullRequestPayload', pr: null };
  if (!found.pr.merged) {
    const sha = squashMerge(state.store, found.repo, found.pr);
    if (sha !== null) {
      found.pr.merged = true;
      found.pr.state = 'closed';
      found.pr.merge_commit_sha = sha;
      found.pr.merged_at = nowIso();
      found.pr.updated_at = nowIso();
    }
  }
  return { __type: 'MergePullRequestPayload', pr: { __type: 'PullRequest', repo: found.repo, pr: found.pr } };
}

function doAddComment(state: ExecState, field: FieldNode): AnyObj {
  const input = inputArg(state, field);
  const found = issueByGlobalId(state.store, String(input.subjectId ?? ''));
  if (!found) return { __type: 'AddCommentPayload', edge: null };
  const comment = {
    id: nextId(state.store),
    body: String(input.body ?? ''),
    user: userFor(state.store, state.store.viewer ?? 'forge'),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  found.issue.comments.push(comment);
  found.issue.updated_at = nowIso();
  const node: AnyObj = { __type: 'Comment', repo: found.repo, issue: found.issue, id: comment.id, body: comment.body };
  return { __type: 'AddCommentPayload', edge: { __type: 'CommentEdge', node } };
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const state: ExecState = { store, variables, errors: [] };
  const data = executeSelection(state, { __type: 'Root' }, op.selection) ?? {};
  const out: Record<string, unknown> = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

/** Handle POST /api/graphql. Returns null when the path is not the GraphQL route. */
export async function handleGraphql(ctx: Ctx): Promise<Reply | null> {
  const { store, method, segments: s } = ctx;
  if (s.length !== 2 || s[0] !== 'api' || s[1] !== 'graphql') return null;
  if (method !== 'POST') return { status: 405, json: { message: 'Method Not Allowed' } };
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    return { status: 200, json: { data: null, errors: [{ message: 'Request body must be valid JSON' }] } };
  }
  const runOne = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { data: null, errors: [{ message: 'Operation must be a JSON object' }] };
    }
    const rec = item as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables)
      ? (rec.variables as Record<string, unknown>)
      : {};
    let ops: Operation[];
    try {
      ops = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Failed to parse query' }] };
    }
    if (ops.length === 0) return { data: null, errors: [{ message: 'Empty query' }] };
    const op = ops.find((o) => o.name === (typeof rec.operationName === 'string' ? rec.operationName : undefined)) ?? ops[0];
    return executeOperation(store, op, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map(runOne) };
  }
  return { status: 200, json: runOne(body) };
}
