// The git object model, packfiles and pkt-lines. Pure implementation: no git binary exists
// in the trial pod, so every byte the suite's git client reads is produced here.
// Object ids are SHA-1; packs are written without deltas (plain deflated objects) which the
// suite accepts, and read with full delta support (OFS_DELTA and REF_DELTA) so any pack the
// suite pushes — including delta-compressed ones — resolves.

import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type ObjType, type Repo, ZERO_OID } from './store.ts';

// -------------------------------------------------------------------------------------------
// object parsing and building
// -------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n', 1)[0];
  const message = text.slice(head.length + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function buildTag(object: string, type: ObjType, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

/** Store an object in a repo and return its id. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const id = hashObject(type, data);
  if (!repo.objects.has(id)) repo.objects.set(id, { type, data });
  return id;
}

export function getObject(repo: Repo, id: string): GitObject | undefined {
  return repo.objects.get(id);
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

/** Collect every object reachable from `roots`, excluding anything reachable from `exclude`. */
export function collectReachable(repo: Repo, roots: string[], exclude: string[] = []): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const excluded = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string, into: Set<string> | Map<string, GitObject>, isExclude: boolean): void => {
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ZERO_OID || seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      if (isExclude) {
        excluded.add(cur);
      } else {
        if (excluded.has(cur)) continue;
        out.set(cur, obj);
      }
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  };
  // Mark the excluded set first (a walk that does not add to `out`).
  for (const id of exclude) {
    const stack = [id];
    const localSeen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ZERO_OID || localSeen.has(cur)) continue;
      localSeen.add(cur);
      excluded.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.sha);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  }
  seen.clear();
  for (const id of roots) walk(id, out, false);
  for (const id of excluded) out.delete(id);
  return out;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a packfile (version 2, no deltas) for the given objects. Order: commits, trees, tags, blobs. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const list = [...objects.entries()];
  const order = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3);
  list.sort((a, b) => order(a[1].type) - order(b[1].type) || (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const [, obj] of list) {
    const deflated = deflateSync(obj.data, { level: 6 });
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    // Varint header: first byte holds type (3 bits) + size low 4 bits + continuation.
    const headerBytes: number[] = [];
    let s = size;
    let first = (typeId << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    headerBytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(
    // SHA-1 of everything before the trailer.
    requireSha1(body),
    'hex',
  );
  return Buffer.concat([body, trailer]);
}

import { createHash } from 'node:crypto';
function requireSha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Read a varint from `buf` at `pos` (7 bits per byte, little-endian base-128). */
function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    const b = buf[i];
    value |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) throw new Error(`delta base size mismatch: ${srcSize} != ${base.length}`);
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) off |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      outLen += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== dstSize) throw new Error(`delta target size mismatch: ${outLen} != ${dstSize}`);
  return Buffer.concat(out);
}

/** Parse a packfile into objects (id -> object), resolving OFS_DELTA and REF_DELTA.
 * `lookup` resolves REF_DELTA bases the pack itself does not carry (objects the server
 * already holds — a thin pack from a client may delta against those). */
export function readPack(pack: Buffer, lookup?: (id: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer checksum.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack checksum mismatch');
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const byId = new Map<string, GitObject>();
  const pending: Array<{ offset: number; type: ObjType; data: Buffer; base: string | number }> = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let b = pack[pos++];
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseRef: string | number | null = null;
    if (typeId === 6) {
      // OFS_DELTA: offset encoded base-128 with the git quirk.
      let off = pack[pos++];
      let base = off & 0x7f;
      while (off & 0x80) {
        off = pack[pos++];
        base = ((base + 1) << 7) | (off & 0x7f);
      }
      baseRef = start - base;
    } else if (typeId === 7) {
      baseRef = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const deflated = pack.subarray(pos);
    const data = inflateSync(deflated);
    // Advance past the zlib stream: re-deflate is not possible; find the stream end by
    // inflating with a fresh chunk and measuring consumed input via a manual loop.
    pos = skipZlib(pack, pos);
    if (data.length !== size) throw new Error(`pack object size mismatch at ${start}: ${data.length} != ${size}`);
    if (typeId >= 1 && typeId <= 4) {
      const type = PACK_TYPES[typeId];
      byOffset.set(start, { type, data });
      byId.set(hashObject(type, data), { type, data });
    } else if (typeId === 6 || typeId === 7) {
      pending.push({ offset: start, type: 'blob', data, base: baseRef as string | number });
    } else {
      throw new Error(`unknown pack object type ${typeId}`);
    }
  }
  // Resolve deltas (they may chain; iterate until all resolve).
  let remaining = pending;
  for (let round = 0; round < 64 && remaining.length > 0; round += 1) {
    const next: typeof remaining = [];
    for (const p of remaining) {
      let baseObj: { type: ObjType; data: Buffer } | undefined;
      if (typeof p.base === 'number') baseObj = byOffset.get(p.base);
      else baseObj = byId.get(p.base) ?? lookup?.(p.base);
      if (!baseObj) {
        next.push(p);
        continue;
      }
      const data = applyDelta(baseObj.data, p.data);
      byOffset.set(p.offset, { type: baseObj.type, data });
      byId.set(hashObject(baseObj.type, data), { type: baseObj.type, data });
    }
    if (next.length === remaining.length) throw new Error('unresolvable delta in pack');
    remaining = next;
  }
  if (remaining.length > 0) throw new Error('unresolvable delta in pack');
  return byId;
}

/** Advance `pos` past a zlib stream in `buf` (deflate streams have no length prefix). */
function skipZlib(buf: Buffer, pos: number): number {
  // A zlib stream ends with an Adler-32 checksum; the reliable way to find its end is to
  // inflate incrementally. Use a small chunked inflate via the sync API on growing slices
  // is wasteful, so instead scan: try inflateSync on slices doubling in size is also bad.
  // Practical approach: inflate with zlib's streaming API is async; here we use a trick —
  // Node's inflateSync throws on trailing garbage only when the stream is truncated, and
  // accepts trailing bytes silently? It does not. So binary-search the end instead.
  let lo = pos;
  let hi = buf.length;
  // First, find any end by trying increasing lengths with a coarse step, then refine.
  // zlib streams in packs are contiguous; the next object's header starts right after.
  // Use inflateSync on candidate slices: it succeeds exactly when the slice ends at the
  // stream boundary (extra bytes cause "incorrect data check" only if they corrupt the
  // stream; trailing bytes are ignored by inflateSync? No — inflateSync requires the
  // input to be exactly one stream... it actually stops at the stream end and ignores
  // trailing data). Test: inflateSync(buf) on a longer slice returns the same output.
  // So: inflate the whole remainder once to get the data, then find the minimal prefix
  // that inflates to the same bytes by binary search.
  const full = inflateSync(buf.subarray(pos));
  let low = pos;
  let high = buf.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const out = inflateSync(buf.subarray(pos, mid));
      if (out.equals(full)) high = mid;
      else low = mid + 1;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

/** Encode one pkt-line (4 hex length digits including themselves, then payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** A parsed pkt-line stream: lines (payloads) and markers. */
export interface PktItem {
  kind: 'line' | 'flush' | 'delim' | 'response-end';
  data?: Buffer;
}

/** Parse a whole buffer of pkt-lines. Throws on a malformed length. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
    } else if (len === 2) {
      items.push({ kind: 'response-end' });
      pos += 4;
    } else {
      if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line length');
      items.push({ kind: 'line', data: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return items;
}

/** Frame a payload as one sideband packet on `channel` (1 = data, 2 = progress, 3 = error). */
export function sideband(channel: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([channel]), data]));
}

/** Split a buffer into sideband packets of at most `maxData` bytes of payload each. */
export function sidebandChunks(channel: 1 | 2 | 3, data: Buffer, maxData = 32768): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += maxData) {
    out.push(sideband(channel, data.subarray(i, Math.min(i + maxData, data.length))));
  }
  if (data.length === 0) out.push(sideband(channel, Buffer.alloc(0)));
  return out;
}
