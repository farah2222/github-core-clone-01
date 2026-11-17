// Git smart-HTTP surface: upload-pack protocol v2 (with a v0 fallback advertisement)
// and receive-pack v0, at /{owner}/{repo}.git.
//
// Byte rules that matter (from the kit's git-client.ts / checks-git.ts):
// - A v2 info/refs answer opens with "version 2" and advertises fetch=shallow,
//   ls-refs=unborn and object-format=sha1. A header-less info/refs answers v0.
// - The v0 advertisements open with "# service=git-<service>\n"; capabilities ride
//   after a NUL on the first line only. Receive-pack must advertise report-status,
//   side-band-64k and delete-refs (the literal key "report-status", not only v2).
// - ls-refs honours ref-prefix filtering server-side; HEAD carries symref-target;
//   annotated tags carry peeled:. An empty repo reports "unborn HEAD".
// - A fetch answers acknowledgments (NAK / ACK), shallow-info, then a packfile section
//   of sideband packets (band 1 = pack). Never send 0002 in a v2 fetch response.
// - A fetch sends exactly reachable(wants) - reachable(haves), depth-limited by deepen.
// - A push is pkt-line commands, a flush, then raw pack bytes; the report is
//   "unpack ok" plus one ok/ng line per command, framed in band-1 sideband packets.
//   A non-fast-forward update is refused with reason exactly "non-fast-forward" and
//   the ref does not move. Refusals are still HTTP 200.
// - A missing repo is 404 on info/refs for both services; a malformed pkt-line POST
//   must not crash the server or corrupt the repo.

import {
  getObject,
  parsePktLines,
  pktLine,
  PKT_FLUSH,
  readPack,
  sidebandChunks,
  writePack,
  type PktItem,
} from './git.ts';
import {
  ancestors,
  collectDepthLimited,
  isAncestor,
  readCommit,
  reachableObjects,
} from './gitops.ts';
import { learnViewer, lookupRepo, type Ctx } from './rest.ts';
import { ZERO_OID, type Repo, type Store } from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';

function gitReply(status: number, contentType: string, body: Buffer): GitReply {
  return { status, contentType, body };
}

function jsonReply(status: number, body: unknown): GitReply {
  return gitReply(status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
}

function line(text: string): Buffer {
  return pktLine(`${text}\n`);
}

// -------------------------------------------------------------------------------------------
// ref listing helpers
// -------------------------------------------------------------------------------------------

/** All refs of a repo, sorted by name: [ref, oid, peeledCommit?]. */
function listRefs(repo: Repo): Array<{ ref: string; oid: string; peeled?: string }> {
  const out: Array<{ ref: string; oid: string; peeled?: string }> = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(ref)!;
    const entry: { ref: string; oid: string; peeled?: string } = { ref, oid };
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) entry.peeled = m[1];
    }
    out.push(entry);
  }
  return out;
}

/** The default branch tip, or the zero oid when the repo is unborn. */
function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? ZERO_OID;
}

const V0_UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main';
const RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

/** v0 advertisement body (upload-pack or receive-pack), with the service preamble. */
function v0Advertisement(service: 'upload' | 'receive', repo: Repo): Buffer {
  const caps = service === 'upload' ? V0_UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [line(`# service=git-${service === 'upload' ? 'upload-pack' : 'receive-pack'}`)];
  const refs = listRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const { ref, oid, peeled } of refs) {
      parts.push(line(`${oid} ${ref}`));
      if (peeled) parts.push(line(`${peeled} ${ref}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement body for upload-pack. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    line('# service=git-upload-pack'),
    line('version 2'),
    line('fetch=shallow'),
    line('ls-refs=unborn'),
    line('object-format=sha1'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const refs = listRefs(repo);
  const matches = (ref: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => ref.startsWith(p));
  if (head === ZERO_OID) {
    // Unborn repo: only HEAD, reported unborn.
    if (matches('HEAD') && args.unborn) {
      parts.push(line(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : ''}`));
    }
  } else {
    if (matches('HEAD')) {
      parts.push(line(`${head} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : ''}`));
    }
    for (const { ref, oid, peeled } of refs) {
      if (!matches(ref)) continue;
      const extra = peeled && args.peel ? ` peeled:${peeled}` : '';
      parts.push(line(`${oid} ${ref}${extra}`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch (v2 and v0)
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseCommitTime(repo: Repo, sha: string): number | null {
  const record = readCommit(repo, sha);
  if (!record) return null;
  const m = record.committer.match(/ (\d+) [+-]\d{4}$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Compute the objects a fetch must send, plus shallow/unshallow boundary lines. */
function computeFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const depth = args.deepen ?? Number.POSITIVE_INFINITY;
  let collected: { objects: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>; boundary: Set<string> };
  if (args.deepenSince !== null) {
    // Time-bounded fetch: include commits at/after `since`; older commits are boundaries.
    const since = args.deepenSince;
    const objects = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
    const boundary = new Set<string>();
    const queue: string[] = [...args.wants];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = getObject(repo, sha);
      if (!obj) continue;
      if (obj.type === 'tag') {
        objects.set(sha, obj);
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) queue.push(m[1]);
        continue;
      }
      if (obj.type !== 'commit') continue;
      const time = parseCommitTime(repo, sha);
      if (time !== null && time < since) {
        boundary.add(sha);
        continue;
      }
      const { objects: closure } = collectDepthLimited(repo, [sha], 1);
      for (const [id, o] of closure) objects.set(id, o);
      const record = readCommit(repo, sha);
      if (record) for (const p of record.parents) queue.push(p);
    }
    collected = { objects, boundary };
  } else {
    collected = collectDepthLimited(repo, args.wants, depth);
  }
  // Exclude everything reachable from the haves, and from deepen-not refs.
  const excluded = new Set<string>();
  if (args.haves.length > 0) {
    for (const id of reachableObjects(repo, args.haves).keys()) excluded.add(id);
  }
  for (const ref of args.deepenNot) {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
    if (tip) for (const id of ancestors(repo, tip)) excluded.add(id);
  }
  const objects = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  for (const [id, obj] of collected.objects) {
    if (!excluded.has(id)) objects.set(id, obj);
  }
  // Shallow boundaries: commits on the depth/time boundary that still have parents
  // and were actually sent (their parents were not).
  const shallow = [...collected.boundary].filter((oid) => objects.has(oid));
  // Unshallow: a previously-shallow commit that is now sent together with a parent.
  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    if (!objects.has(oid)) continue;
    const record = readCommit(repo, oid);
    if (record && record.parents.some((p) => objects.has(p))) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

function ackLines(repo: Repo, args: FetchArgs): string[] {
  if (args.haves.length === 0) return ['NAK'];
  const lines: string[] = [];
  for (const have of args.haves) {
    const common = args.wants.some((want) => isAncestor(repo, have, want));
    if (common) lines.push(`ACK ${have}`);
  }
  return lines.length > 0 ? lines : ['NAK'];
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(line('acknowledgments'));
  for (const ack of ackLines(repo, args)) parts.push(line(ack));
  parts.push(PKT_FLUSH);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(line('shallow-info'));
    for (const oid of shallow) parts.push(line(`shallow ${oid}`));
    for (const oid of unshallow) parts.push(line(`unshallow ${oid}`));
    parts.push(PKT_FLUSH);
  }
  if (objects.size > 0) {
    parts.push(line('packfile'));
    const pack = writePack(objects);
    for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  for (const ack of ackLines(repo, args)) parts.push(line(ack));
  for (const oid of shallow) parts.push(line(`shallow ${oid}`));
  for (const oid of unshallow) parts.push(line(`unshallow ${oid}`));
  if (objects.size > 0) {
    const pack = writePack(objects);
    for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack POST
// -------------------------------------------------------------------------------------------

function parseUploadPackV2(items: PktItem[]): { command: string; lsRefs: LsRefsArgs; fetch: FetchArgs } | null {
  let command = '';
  const lsRefs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  let afterDelim = false;
  for (const item of items) {
    if (item.kind === 'flush') continue;
    if (item.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (item.kind !== 'line' || !item.data) continue;
    const text = item.data.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    if (command === 'ls-refs') {
      if (text === 'peel') lsRefs.peel = true;
      else if (text === 'symrefs') lsRefs.symrefs = true;
      else if (text === 'unborn') lsRefs.unborn = true;
      else if (text.startsWith('ref-prefix ')) lsRefs.prefixes.push(text.slice('ref-prefix '.length));
    } else if (command === 'fetch') {
      if (text.startsWith('want ')) fetch.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) fetch.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) fetch.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) fetch.deepen = Number.parseInt(text.slice(7).trim(), 10);
      else if (text.startsWith('deepen-since ')) fetch.deepenSince = Number.parseInt(text.slice(13).trim(), 10);
      else if (text.startsWith('deepen-not ')) fetch.deepenNot.push(text.slice(11).trim());
      // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action needed.
    }
  }
  if (command === '') return null;
  return { command, lsRefs, fetch };
}

function parseUploadPackV0(items: PktItem[]): FetchArgs | null {
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  let sawWant = false;
  for (const item of items) {
    if (item.kind === 'flush' || item.kind === 'delim') continue;
    if (item.kind !== 'line' || !item.data) continue;
    const text = item.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      sawWant = true;
      fetch.wants.push(text.slice(5).split(' ')[0]);
    } else if (text.startsWith('have ')) {
      fetch.haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      fetch.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      fetch.deepen = Number.parseInt(text.slice(7).trim(), 10);
    } else if (text === 'done') {
      // end of haves section
    }
  }
  return sawWant ? fetch : null;
}

// -------------------------------------------------------------------------------------------
// receive-pack POST
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPush(store: Store, repo: Repo, commands: PushCommand[]): string[] {
  const lines: string[] = ['unpack ok'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push(`ng ${cmd.ref} remote ref does not exist`);
      } else {
        repo.refs.delete(cmd.ref);
        lines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (!getObject(repo, cmd.newOid)) {
      lines.push(`ng ${cmd.ref} unable to read new object`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        lines.push(`ng ${cmd.ref} already exists`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        lines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      lines.push(`ng ${cmd.ref} remote ref does not exist`);
      continue;
    }
    if (current !== cmd.oldOid) {
      lines.push(`ng ${cmd.ref} stale old oid`);
      continue;
    }
    if (cmd.oldOid === cmd.newOid) {
      lines.push(`ok ${cmd.ref}`);
      continue;
    }
    if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      lines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}`);
  }
  return lines;
}

function reportSideband(reportLines: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const text of reportLines) {
    // Each report pkt-line rides inside a band-1 sideband packet.
    const framed = pktLine(`${text}\n`);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), framed])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitReply {
  // Split the body at the first flush pkt-line: commands before it, pack bytes after.
  let commandsEnd = -1;
  let pos = 0;
  const commands: PushCommand[] = [];
  let malformed = false;
  try {
    while (pos + 4 <= body.length) {
      const len = Number.parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
      if (Number.isNaN(len) || len < 0 || len > 65520) {
        malformed = true;
        break;
      }
      if (len === 0) {
        commandsEnd = pos + 4;
        break;
      }
      if (len < 4 || pos + len > body.length) {
        malformed = true;
        break;
      }
      const payload = body.subarray(pos + 4, pos + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const text = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length === 3 && /^[0-9a-f]{40}$/i.test(parts[0]) && /^[0-9a-f]{40}$/i.test(parts[1]) && parts[2].startsWith('refs/')) {
        commands.push({ oldOid: parts[0].toLowerCase(), newOid: parts[1].toLowerCase(), ref: parts[2] });
      } else {
        malformed = true;
        break;
      }
      pos += len;
    }
  } catch {
    malformed = true;
  }
  if (malformed || commandsEnd < 0) {
    // Unpack failure: HTTP 200, unpack line not ok, one ng per command seen.
    const lines = ['unpack malformed request'];
    for (const cmd of commands) lines.push(`ng ${cmd.ref} unpack failed`);
    if (commands.length === 0) lines.push('ng refs/heads/main unpack failed');
    return gitReply(200, RECEIVE_RESULT, reportSideband(lines));
  }
  const packBytes = body.subarray(commandsEnd);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (id) => getObject(repo, id));
      for (const [id, obj] of objects) {
        if (!repo.objects.has(id)) repo.objects.set(id, obj);
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unpack failed';
      const lines = [`unpack ${detail}`];
      for (const cmd of commands) lines.push(`ng ${cmd.ref} unpack failed`);
      return gitReply(200, RECEIVE_RESULT, reportSideband(lines));
    }
  }
  const report = applyPush(store, repo, commands);
  return gitReply(200, RECEIVE_RESULT, reportSideband(report));
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

/** Handle a git smart-HTTP request. Returns null when the path is not a git route. */
export async function handleGit(ctx: Ctx): Promise<GitReply | null> {
  const { store, method, segments: s } = ctx;
  if (s.length < 2) return null;
  const repoSegment = s[1];
  if (!repoSegment.endsWith('.git')) return null;
  const owner = decodeURIComponent(s[0]);
  const name = decodeURIComponent(repoSegment.slice(0, -4));
  const rest = s.slice(2);

  const lookup = lookupRepo(store, owner, name);
  if (lookup.status !== 'ok') {
    return jsonReply(404, { message: 'Not Found' });
  }
  const repo = lookup.repo;
  learnViewer(store, owner);

  // GET /info/refs?service=...
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    const wantsV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      return wantsV2
        ? gitReply(200, UPLOAD_AD, v2Advertisement())
        : gitReply(200, UPLOAD_AD, v0Advertisement('upload', repo));
    }
    if (service === 'git-receive-pack') {
      return gitReply(200, RECEIVE_AD, v0Advertisement('receive', repo));
    }
    return jsonReply(404, { message: 'Not Found' });
  }

  // POST git-upload-pack (v2 when the Git-Protocol header asks, else v0).
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    let items: PktItem[];
    try {
      items = parsePktLines(ctx.body);
    } catch {
      return jsonReply(400, { message: 'Malformed pkt-line stream' });
    }
    const wantsV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    if (wantsV2) {
      const parsed = parseUploadPackV2(items);
      if (!parsed) return jsonReply(400, { message: 'Malformed upload-pack request' });
      if (parsed.command === 'ls-refs') {
        return gitReply(200, UPLOAD_RESULT, handleLsRefs(repo, parsed.lsRefs));
      }
      if (parsed.command === 'fetch') {
        return gitReply(200, UPLOAD_RESULT, handleFetchV2(repo, parsed.fetch));
      }
      return jsonReply(400, { message: `Unknown upload-pack command: ${parsed.command}` });
    }
    const fetch = parseUploadPackV0(items);
    if (!fetch) return jsonReply(400, { message: 'Malformed upload-pack request' });
    return gitReply(200, UPLOAD_RESULT, handleFetchV0(repo, fetch));
  }

  // POST git-receive-pack (v0 only).
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    return handleReceivePack(store, repo, ctx.body);
  }

  return jsonReply(404, { message: 'Not Found' });
}
