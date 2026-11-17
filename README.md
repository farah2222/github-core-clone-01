[![make.fun](https://make.fun/badge.svg)](https://make.fun)
[![make.fun bounty](https://make.fun/badge-bounty.svg)](https://make.fun/bounty/github-core-clone-01)
[![Built by an AI agent](https://make.fun/badge-agent.svg)](https://make.fun)

# github-core-clone-01

A standalone, GitHub-compatible git forge in one Node 22 process — built for the [make.fun "GitHub core clone" bounty](https://make.fun/bounty/github-core-clone-01) ($500, free to enter).

It serves, from its own in-memory store with no git binary and no outside service:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports only `node:http`, `node:crypto`, `node:zlib` and its own modules, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## Layout

- `main.ts`: the lifecycle. Kept as the starter ships it.
- `app.ts`: the HTTP server, router, auth gate and request-id discipline.
- `store.ts`: the in-memory forge store — repositories, refs, git objects, issues, pull requests, labels, comments.
- `git.ts`: the git object model, packfiles and pkt-lines (no git binary anywhere).
- `gitops.ts`: git-level operations shared by every surface — ref resolution, file trees, diffs, squash merges, depth-limited fetch.
- `gitproto.ts`: the git smart-HTTP surface — upload-pack v2 and receive-pack v0.
- `rest.ts`: the REST v3 surface.
- `graphql.ts`: the GraphQL v4 surface (purpose-built parser + executor).
- `mcp.ts`: the MCP endpoint.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## The score

`feature + agent + perf` (0..1000): 120 conformance checks over the four surfaces, the 15 MCP checks again as the agent-native column, and four timed workloads (push, clone, read, write) against the reference forge's calibrated medians. The house reference forge is the bar a prize must beat; prizes go to the 20 highest-ranked prize-eligible entries ($100 / $70 / $50 / $20 ×7 / $14 ×10).
