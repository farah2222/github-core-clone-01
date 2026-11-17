// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
// (modern era via server/discover, no handshake) with a legacy initialize fallback.
// Six tools, all acting on the same store as REST and GraphQL.
//
// Responses are single JSON bodies (the suite accepts those). Notifications (no id) get
// HTTP 202 with no body. A malformed JSON body gets HTTP 400 with JSON-RPC -32700.
// Auth (401) is decided by app.ts before this runs, ahead of tool existence.

import { squashMerge } from './gitops.ts';
import {
  createIssueRecord,
  createPullRecord,
  createRepoRecord,
  issueJson,
  learnViewer,
  lookupRepo,
  pullJson,
  repoJson,
  type Ctx,
  type Reply,
} from './rest.ts';
import { nowIso, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

function strProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function boolProp(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

/** The tool list, built fresh in a fixed order every call (byte-identical across calls). */
function toolList(): ToolDef[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: strProp('The repository name.'),
          description: strProp('A short description of the repository.'),
          private: boolProp('Whether the repository is private.'),
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: strProp('The login of the repository owner.'),
          repo: strProp('The repository name.'),
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: strProp('The login of the repository owner.'),
          repo: strProp('The repository name.'),
          title: strProp('The issue title.'),
          body: strProp('The issue body.'),
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: strProp('The login of the repository owner.'),
          repo: strProp('The repository name.'),
          state: strProp('Filter by state: open, closed, or all.'),
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: strProp('The login of the repository owner.'),
          repo: strProp('The repository name.'),
          title: strProp('The pull request title.'),
          head: strProp('The head branch name.'),
          base: strProp('The base branch name.'),
          body: strProp('The pull request body.'),
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request (squash) in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: strProp('The login of the repository owner.'),
          repo: strProp('The repository name.'),
          pull_number: { type: 'integer', description: 'The pull request number.' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  ];
}

const TOOL_NAMES = new Set(toolList().map((t) => t.name));

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Split an "owner/repo" full name into its parts. */
function splitFullName(value: string): { owner: string; repo: string } | null {
  const idx = value.indexOf('/');
  if (idx <= 0 || idx === value.length - 1) return null;
  return { owner: value.slice(0, idx), repo: value.slice(idx + 1) };
}

/** Resolve owner/repo from tool arguments, honouring a full_name property. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  const fullName = asString(args.full_name ?? args.fullName ?? '');
  if (fullName !== '') {
    const split = splitFullName(fullName);
    if (split) return split;
  }
  return { owner: asString(args.owner), repo: asString(args.repo) };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === '') return errorResult('Missing required argument: name');
      const ownerArg = asString(args.owner);
      if (ownerArg !== '') learnViewer(store, ownerArg);
      const repo = createRepoRecord(store, repoName, asBool(args.private, false), asString(args.description));
      if (!repo) return errorResult('Repository already exists');
      const data = repoJson(store, repo) as Record<string, unknown>;
      data.full_name = repo.owner !== '' ? `${repo.owner}/${repo.name}` : repo.name;
      return textResult(data);
    }
    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (owner === '' || repoName === '') return errorResult('Missing required arguments: owner, repo');
      const lookup = lookupRepo(store, owner, repoName);
      if (lookup.status !== 'ok') return errorResult('Repository not found');
      const data = repoJson(store, lookup.repo) as Record<string, unknown>;
      data.full_name = lookup.repo.owner !== '' ? `${lookup.repo.owner}/${lookup.repo.name}` : lookup.repo.name;
      return textResult(data);
    }
    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = asString(args.title);
      if (owner === '' || repoName === '' || title === '') {
        return errorResult('Missing required arguments: owner, repo, title');
      }
      const lookup = lookupRepo(store, owner, repoName);
      if (lookup.status !== 'ok') return errorResult('Repository not found');
      const issue = createIssueRecord(store, lookup.repo, title, asString(args.body), []);
      const data = issueJson(store, lookup.repo, issue) as Record<string, unknown>;
      return textResult(data);
    }
    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (owner === '' || repoName === '') return errorResult('Missing required arguments: owner, repo');
      const lookup = lookupRepo(store, owner, repoName);
      if (lookup.status !== 'ok') return errorResult('Repository not found');
      const state = asString(args.state).toLowerCase() || 'open';
      const issues = lookup.repo.issues.filter((i) => state === 'all' || i.state === state);
      const data = {
        issues: issues.map((i) => issueJson(store, lookup.repo, i)),
        total_count: issues.length,
      };
      return textResult(data as unknown as Record<string, unknown>);
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return errorResult('Missing required arguments: owner, repo, title, head, base');
      }
      const lookup = lookupRepo(store, owner, repoName);
      if (lookup.status !== 'ok') return errorResult('Repository not found');
      const pr = createPullRecord(store, lookup.repo, head, base, title, asString(args.body));
      if (!pr) return errorResult('Head or base branch not found');
      const data = pullJson(store, lookup.repo, pr) as Record<string, unknown>;
      data.pull_number = pr.number;
      return textResult(data);
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const pullNumber = asNumber(args.pull_number ?? args.number);
      if (owner === '' || repoName === '' || pullNumber === null) {
        return errorResult('Missing required arguments: owner, repo, pull_number');
      }
      const lookup = lookupRepo(store, owner, repoName);
      if (lookup.status !== 'ok') return errorResult('Repository not found');
      const pr = lookup.repo.pulls.find((p) => p.number === pullNumber);
      if (!pr) return errorResult('Pull request not found');
      if (pr.merged) {
        return textResult({ merged: true, pull_number: pr.number, sha: pr.merge_commit_sha });
      }
      const sha = squashMerge(store, lookup.repo, pr);
      if (sha === null) return errorResult('Merge conflict');
      pr.merged = true;
      pr.state = 'closed';
      pr.merge_commit_sha = sha;
      pr.merged_at = nowIso();
      pr.updated_at = nowIso();
      return textResult({ merged: true, pull_number: pr.number, sha });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC
// -------------------------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Handle POST /mcp. Returns null when the path is not the MCP route. */
export async function handleMcp(ctx: Ctx): Promise<Reply | null> {
  const { store, method, segments: s } = ctx;
  if (s.length !== 1 || s[0] !== 'mcp') return null;
  if (method !== 'POST') return { status: 405, json: { message: 'Method Not Allowed' } };

  let req: RpcRequest;
  try {
    req = JSON.parse(ctx.body.toString('utf8')) as RpcRequest;
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
  }

  const id = req.id ?? null;

  // A notification (no id) is acknowledged with 202 and no body.
  if (req.method.startsWith('notifications/')) {
    return { status: 202, json: null, empty: true };
  }

  if (req.method === 'server/discover') {
    const headerVersion = (ctx.headers['mcp-protocol-version'] ?? '').trim();
    if (headerVersion !== '' && headerVersion !== MODERN_VERSION) {
      return { status: 200, json: rpcError(id, -32022, `Unsupported protocol version: ${headerVersion}`, { supported: SUPPORTED_VERSIONS }) };
    }
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      json: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      }),
    };
  }

  if (req.method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (req.method === 'tools/list') {
    return { status: 200, json: rpcResult(id, { tools: toolList() }) };
  }

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!TOOL_NAMES.has(toolName)) {
      return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const result = callTool(store, toolName, args);
    return { status: 200, json: rpcResult(id, result) };
  }

  return { status: 200, json: rpcError(id, -32601, `Method not found: ${req.method}`) };
}
