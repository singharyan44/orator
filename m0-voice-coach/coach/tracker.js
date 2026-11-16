// Owner traffic tracker — pure command builders, no network, no secrets.
// The server (server/index.js) executes the commands against Upstash Redis
// REST when configured; without env vars every endpoint answers
// { enabled: false } and nothing on the site changes.
//
// What is counted (counts ONLY — the app's privacy posture):
// - page views + 60 s heartbeats → "viewers right now" = tabs seen within
//   the last LIVE_WINDOW_MS
// - button presses, whitelisted names only
// Uniques are HyperLogLog: a session is countable but never reversible.
// Sessions are random per-tab IDs (crypto.randomUUID), never IPs.

const LIVE_WINDOW_MS = 60000; // a viewer counts if seen within the last 60 s
const DAY_TTL_S = 3456000;    // daily keys expire after ~40 days
const LIVE_TTL_S = 172800;    // live ZSET self-cleans if never read

// Press names the client may report (exact whitelist — /api/track rejects
// anything else, so the public endpoint cannot write arbitrary keys).
const PRESS_NAMES = [
  'connect',
  'attempt_start',
  'retry',
  'sample_play',
  'debate_start',        // text and voice debates share one Start button
  'debate_round_start',
  'diagnose_debate',
  'interview_start',
  'interview_answer_start',
  'diagnose_interview',
];

// UTC day key: serverless has no reliable local timezone, and one clock for
// "today" everywhere keeps the script's numbers honest.
function dayKey(now) {
  const d = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}

function cleanSession(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return s || 'anon';
}

// Build the Redis pipeline for one client event. Returns null for unknown
// types/names — the caller answers 400 (also the abuse guard).
function trackCommands({ type, name, session, now }) {
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const sess = cleanSession(session);
  if (type === 'view') {
    const day = 'stats:' + dayKey(t);
    const uv = 'uv:' + dayKey(t);
    return [
      ['ZADD', 'live', String(t), sess],
      ['HINCRBY', 'stats', 'views', 1],
      ['HINCRBY', day, 'views', 1],
      ['EXPIRE', day, DAY_TTL_S],
      ['PFADD', uv, sess],
      ['PFADD', 'uvall', sess],
    ];
  }
  if (type === 'heartbeat') return [['ZADD', 'live', String(t), sess]];
  if (type === 'press') {
    const n = String(name || '');
    if (!PRESS_NAMES.includes(n)) return null;
    const day = 'stats:' + dayKey(t);
    return [
      ['HINCRBY', 'stats', 'presses:' + n, 1],
      ['HINCRBY', day, 'presses:' + n, 1],
      ['EXPIRE', day, DAY_TTL_S],
    ];
  }
  return null;
}

// Pipeline that answers GET /api/stats. Order matters — parseStatsResults
// reads results by index.
function statsCommands(now) {
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const since = String(t - LIVE_WINDOW_MS);
  return [
    ['ZREMRANGEBYSCORE', 'live', '-inf', since], // drop stale viewers
    ['ZCOUNT', 'live', since, '+inf'],           // [1] live viewer count
    ['HGETALL', 'stats'],                        // [2] all-time counters
    ['HGETALL', 'stats:' + dayKey(t)],           // [3] today's counters
    ['PFCOUNT', 'uv:' + dayKey(t)],              // [4] unique tabs today
    ['PFCOUNT', 'uvall'],                        // [5] unique tabs all time
    ['EXPIRE', 'live', LIVE_TTL_S],              // housekeeping
  ];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// Upstash REST returns HGETALL as { field: value }; tolerate flat
// [k1, v1, ...] pair arrays too.
function hashOf(entry) {
  const raw = entry && entry.result !== undefined ? entry.result : null;
  const out = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  } else if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) out[k] = raw[k];
  }
  return out;
}

function pressesOf(hash) {
  const out = {};
  for (const n of PRESS_NAMES) out[n] = num(hash['presses:' + n]);
  return out;
}

function parseStatsResults(results, now) {
  const r = Array.isArray(results) ? results : [];
  const at = (i) => (r[i] === undefined || r[i] === null ? {} : r[i]);
  const allTime = hashOf(at(2));
  const today = hashOf(at(3));
  return {
    enabled: true,
    day: dayKey(now),
    liveWindowSec: LIVE_WINDOW_MS / 1000,
    liveViewers: num(at(1).result),
    today: {
      views: num(today.views),
      uniques: num(at(4).result),
      presses: pressesOf(today),
    },
    allTime: {
      views: num(allTime.views),
      uniques: num(at(5).result),
      presses: pressesOf(allTime),
    },
  };
}

function trackerConfigured(env) {
  const e = env || {};
  return Boolean(e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LIVE_WINDOW_MS, PRESS_NAMES, dayKey, trackCommands, statsCommands, parseStatsResults, trackerConfigured };
}
