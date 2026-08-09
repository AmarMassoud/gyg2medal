'use strict';
/**
 * Client for the Gif Your Game backend.
 *
 * GYG runs a Parse Server at https://api.gifyourgame.com/parse, application
 * id "badpanda". Only the public REST surface the website itself uses, always
 * as the signed-in user.
 *
 * Getting from a clip to a downloadable file is the awkward part:
 *
 *   Clip (class) --gyg pointer--> Gyg (class) --> gyg.name is the media slug
 *   https://media.gifyourgame.com/<slug>_720p.mp4
 *
 * The Gyg class blocks both find and get for normal users, so slugs have to
 * come from the `fetchClip` cloud function, which runs with elevated rights
 * and returns the Gyg inline. There is no batch form -- fetchClip rejects
 * arrays and fetchGyg is also one-at-a-time -- so the only lever is
 * concurrency.
 *
 * CONCURRENCY was measured against the live service, not guessed:
 *
 *     6 workers -> 28.7 req/s, median 189 ms
 *    16 workers -> 74.1 req/s, median 197 ms   <-- chosen
 *    32 workers -> 81.1 req/s, median 385 ms   (latency doubles for +9%)
 *
 * 16 is where throughput stops being free. Beyond it we would just be making
 * a service that is being wound down work harder for no real gain.
 */

const APP_ID = 'badpanda';
const API = 'https://api.gifyourgame.com/parse';
const MEDIA = 'https://media.gifyourgame.com';
const THUMBS = 'https://thumbs.gifyourgame.com';

const CONCURRENCY = 16;
const TIMEOUT_MS = 30000;
const RETRIES = 4;

class GygError extends Error {}
class AuthError extends GygError {}

function headers(token, json) {
  const h = { 'X-Parse-Application-Id': APP_ID };
  if (token) h['X-Parse-Session-Token'] = token;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function request(pathname, { method = 'GET', token, body, query, timeout = TIMEOUT_MS } = {}) {
  let url = API + pathname;
  if (query) url += '?' + new URLSearchParams(query).toString();

  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: headers(token, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }

      if (res.ok) return parsed ?? {};

      const code = parsed && parsed.code;
      const message = (parsed && parsed.error) || text.slice(0, 200);
      if (code === 101) throw new AuthError(message);
      if (code === 209) throw new AuthError('Your GYG session expired. Sign in again.');
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new GygError(message);
      lastErr = new GygError(message);
    } catch (e) {
      if (e instanceof AuthError || e instanceof GygError) throw e;
      lastErr = new GygError(e.name === 'AbortError' ? 'Request timed out' : String(e.message || e));
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
  }
  throw lastErr || new GygError('Request failed');
}

/** Run `worker` over `items` with a fixed number of parallel lanes. */
async function pooled(items, limit, worker) {
  let index = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

class GygClient {
  constructor(sessionToken, username = '', userId = '') {
    this.token = sessionToken;
    this.username = username;
    this.userId = userId;
  }

  /** Validate a session token captured from the real GYG login window. */
  static async fromToken(sessionToken) {
    const token = String(sessionToken || '').trim();
    if (!token) throw new AuthError('No session token.');
    const me = await request('/users/me', { token });
    return new GygClient(token, me.username || '', me.objectId || '');
  }

  where(includeDeleted) {
    const w = { user: { __type: 'Pointer', className: '_User', objectId: this.userId } };
    if (!includeDeleted) w.deleted = { $ne: true };
    return w;
  }

  async listRawClips(onCount) {
    const keys = 'objectId,name,game,length,createdAt,status,gygStatus,gyg,isVertical,deleted,tags';
    const where = JSON.stringify(this.where(false));
    const out = [];
    let skip = 0;
    for (;;) {
      const page = await request('/classes/Clip', {
        token: this.token,
        query: { limit: 1000, skip, order: 'createdAt', where, keys },
      });
      const batch = page.results || [];
      out.push(...batch);
      if (onCount) onCount(out.length);
      if (batch.length < 1000) break;
      skip += batch.length;
      if (skip > 100000) break;
    }
    return out;
  }

  async gameNames(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const page = await request('/classes/Game', {
        token: this.token,
        query: {
          limit: 1000,
          where: JSON.stringify({ objectId: { $in: ids.slice(i, i + 100) } }),
          keys: 'objectId,name,slug',
        },
      });
      for (const g of page.results || []) map.set(g.objectId, g.name || g.slug || g.objectId);
    }
    return map;
  }

  /** fetchClips returns the 100 newest clips with the Gyg already inlined. */
  async seedRecent() {
    const seeded = new Map();
    try {
      const res = await request('/functions/fetchClips', { method: 'POST', token: this.token, body: {} });
      for (const c of res.result || []) {
        if (c && c.gyg && c.gyg.name) seeded.set(c.objectId, c.gyg);
      }
    } catch { /* optimisation only; ignore */ }
    return seeded;
  }

  async resolveOne(clipId) {
    try {
      const res = await request('/functions/fetchClip', {
        method: 'POST', token: this.token, body: { clipId },
      });
      const gyg = res.result && res.result.gyg;
      return gyg && gyg.name ? gyg : null;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      return null;
    }
  }

  /**
   * Build the full downloadable clip list.
   * onProgress({stage, done, total}) is called as it goes.
   */
  async buildClipList({ onProgress = () => {}, signal } = {}) {
    onProgress({ stage: 'Reading your clip list…', done: 0, total: 0 });
    const raw = await this.listRawClips((n) =>
      onProgress({ stage: `Found ${n} clips…`, done: 0, total: 0 }));

    const gameIds = [...new Set(raw.map((c) => c.game && c.game.objectId).filter(Boolean))];
    const games = await this.gameNames(gameIds);

    const pending = raw.filter((c) => c.gyg && c.gyg.objectId);
    const total = pending.length;

    const resolved = await this.seedRecent();
    let done = [...resolved.keys()].filter((id) => pending.some((p) => p.objectId === id)).length;

    const todo = pending.filter((c) => !resolved.has(c.objectId)).map((c) => c.objectId);
    const failed = [];

    onProgress({ stage: `Looking up ${total} clips…`, done, total });

    await pooled(todo, CONCURRENCY, async (clipId) => {
      if (signal && signal.aborted) return;
      const gyg = await this.resolveOne(clipId);
      if (gyg) resolved.set(clipId, gyg);
      else failed.push(clipId);
      done++;
      if (done % 10 === 0 || done === total) {
        onProgress({ stage: `Looking up clips… ${done} of ${total}`, done, total });
      }
    });

    const clips = [];
    for (const c of pending) {
      const gyg = resolved.get(c.objectId);
      if (!gyg) continue;
      const endpoints = gyg.videoEndpoints || {};
      const quality = endpoints['720p60'] ? '720p' : '360p';
      const created = typeof c.createdAt === 'object' ? c.createdAt.iso : c.createdAt;
      clips.push({
        clipId: c.objectId,
        slug: gyg.name,
        title: String(gyg.title || c.name || '').trim(),
        game: games.get(c.game && c.game.objectId) || 'Unknown',
        createdAt: created || '',
        length: Number(c.length) || 0,
        quality,
        url: `${MEDIA}/${gyg.name}_${quality}.mp4`,
        thumb: `${THUMBS}/${gyg.name}.webp`,
        // GYG auto-tags: map, playlist, rank, clip type. Carried into Medal
        // as hashtags by medal.setClipTags.
        tags: (Array.isArray(c.tags) ? c.tags : [])
          .filter((t) => t && t.slug)
          .map((t) => ({ slug: t.slug, category: t.category || '' })),
      });
    }
    clips.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    onProgress({ stage: `Ready: ${clips.length} clips`, done: total, total });
    return { clips, failed };
  }
}

module.exports = { GygClient, GygError, AuthError, CONCURRENCY, pooled };
