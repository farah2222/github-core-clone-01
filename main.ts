// main.ts — how this process lives and dies.
//
// The env (the harness running the trial) owns port 8080 and reaches this process through
// MAKEFUN_ENV_URL. This file only connects the two:
//   1. start the app server on a port the kernel picks (never 8080 — that is the env's);
//   2. tell the env that port, with POST /register;
//   3. ask the env, over and over, whether the trial is finished (GET /done);
//   4. when the env says yes, close the server and leave with code 0.
//
// Serving requests is entirely app.ts's job; nothing in this file handles one. The process
// stays up for exactly as long as the env needs it, and it leaves at once with code 1
// when it cannot do its job — no env URL, or the env refuses the registration outright.

import { createApp } from './app.ts';

// The env's origin, trailing slashes removed so the paths below join cleanly.
const ENV_BASE = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const NO_ENV_MESSAGE = '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n';
if (ENV_BASE === '') {
  process.stderr.write(NO_ENV_MESSAGE);
  process.exit(1);
}

/** Longest a single call to the env may run before it is dropped and tried again. */
const CALL_TIMEOUT_MS = 30_000;
/** Pause before the first retry, and the longest pause the backoff ever grows to. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

/** Pause for `ms` milliseconds. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to pause after `failures` failed calls: the pause doubles each time from
 * BACKOFF_FIRST_MS and never passes BACKOFF_LIMIT_MS. The doubling stops after eight
 * steps, so the pause stays bounded however long the env stays away.
 */
function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

/**
 * One call to the env, with the shared timeout applied. This only makes the request;
 * what a status means is up to the caller.
 */
async function envCall(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ENV_BASE}${path}`, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
}

/** How a refused registration is recognised: the start of the error it throws. */
const REGISTER_REFUSED = 'register answered HTTP ';

/**
 * Tell the env which port the server bound. 200 means the env recorded it. 409 means
 * another entry registered first; this one simply waits along with everyone else. 400
 * or 405 mean the registration itself is wrong, so the program ends at once. Anything
 * else — the env still starting, a dropped connection, an unexpected status — is tried
 * again forever, with the pause between attempts growing as it goes.
 */
async function announcePort(port: number): Promise<void> {
  const payload = JSON.stringify({ port });
  for (let failures = 0; ; failures += 1) {
    const res = await envCall('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).catch(() => null);
    if (res === null) {
      await wait(backoffDelay(failures));
      continue;
    }
    if (res.status === 200) return;
    if (res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      const detail = await res.text().catch(() => null);
      if (detail === null) {
        await wait(backoffDelay(failures));
        continue;
      }
      throw new Error(`${REGISTER_REFUSED}${res.status}: ${detail}`);
    }
    await wait(backoffDelay(failures));
  }
}

/**
 * Ask the env whether the trial is over, again and again, until it says yes. The env
 * answers at once — {"done": false} while the suite is still running — so this is a
 * plain poll, not a request held open. A poll that fails, times out, or comes back
 * unreadable only means "not yet": pause a little and ask again. Never returns early.
 */
async function pollUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    const res = await envCall('/done').catch(() => null);
    if (res !== null && res.ok) {
      const body = (await res.json().catch(() => null)) as { done?: unknown } | null;
      if (body !== null && body.done === true) return;
    }
    await wait(backoffDelay(failures));
  }
}

/** Start the server on a kernel-chosen port; reject if it cannot bind. */
function listenOnFreePort(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
}

/**
 * The whole life of the process: bind the server to a kernel-chosen port, announce
 * that port to the env, wait for the env to finish the trial, then close the server.
 */
async function run(): Promise<void> {
  const server = createApp();
  await listenOnFreePort(server);
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write(`[entry] registered; waiting for the env to say done\n`);

  await pollUntilDone();
  server.close();
  process.stdout.write(`[entry] done\n`);
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write('[entry] ' + (err instanceof Error ? err.message : String(err)) + '\n');
    return process.exit(1);
  },
);
