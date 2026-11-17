// The HTTP server: routing, auth, and the JSON discipline every surface shares.
//
// Routing:
//   GET  /healthz                 the env's boot check (200 {"ok":true})
//   /api/v3/*                     REST v3 (rest.ts)
//   POST /api/graphql            GraphQL v4 (graphql.ts)
//   POST /mcp                    MCP over Streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/*        git smart HTTP (gitproto.ts)
//   anything else                404 {"message":"Not Found"}
//
// Auth: every API call carries Authorization: Bearer $MAKEFUN_SHOP_TOKEN. A request
// without the token is 401 with a JSON {"message": ...} body — except GET /api/v3[/]
// and GET /api/v3/meta, which are public like api.github.com's. The git surface also
// requires the token.
//
// Every reply carries a non-empty X-GitHub-Request-Id header, including errors and
// 204/202 empty replies. A handler must never take the server down: an unexpected
// throw becomes a 500 JSON reply and the server keeps serving.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleGit, type GitReply } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Ctx, type Reply } from './rest.ts';
import { createStore, type Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** Largest request body accepted (git pushes in this suite stay far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries the shop token (or when no token is configured). */
function isAuthenticated(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  if (body === null) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...extraHeaders });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

function sendGit(res: ServerResponse, reply: GitReply, requestId: string): void {
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': reply.body.length,
    'x-github-request-id': requestId,
  });
  res.end(reply.body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store: Store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = randomUUID();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const segments = path.split('/').filter((seg) => seg !== '');
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        const body = await readBody(req);
        const host = req.headers.host ?? 'localhost';
        const ctx: Ctx = { store, method, path, segments, query: url.searchParams, headers, body, host };

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          if (!isAuthenticated(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const reply = await handleGit(ctx);
          if (reply) {
            sendGit(res, reply, requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // GraphQL v4.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (!isAuthenticated(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const reply = await handleGraphql(ctx);
          if (reply) {
            sendJson(res, reply.status, reply.json, requestId, reply.headers);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (!isAuthenticated(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const reply = await handleMcp(ctx);
          if (reply) {
            if (reply.empty) {
              sendJson(res, reply.status, null, requestId, reply.headers);
            } else {
              sendJson(res, reply.status, reply.json, requestId, reply.headers);
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // REST v3.
        if (segments.length >= 1 && segments[0] === 'api' && segments.length >= 2 && segments[1] === 'v3') {
          const isPublic = segments.length === 2 || (segments.length === 3 && segments[2] === 'meta');
          if (!isPublic && !isAuthenticated(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const restCtx: Ctx = { ...ctx, segments: segments.slice(2) };
          const reply: Reply | null = await handleRest(restCtx);
          if (reply) {
            if (reply.empty) {
              sendJson(res, reply.status, null, requestId, reply.headers);
            } else {
              sendJson(res, reply.status, reply.json, requestId, reply.headers);
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (e) {
        process.stderr.write(`[entry] request failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        } else {
          res.end();
        }
      }
    })();
  });
}
