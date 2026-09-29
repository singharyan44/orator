// Practice stats + timer helpers (pure, unit-tested).
// UMD: browser global via <script> tag, require()-able in Node for tests.

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// history records: { metrics: {durationSec}, createdAt }. Streak = consecutive
// calendar days with ≥1 attempt, ending today or yesterday.
function dayStats(history, now) {
  const list = Array.isArray(history) ? history : [];
  const today = dayKey(now || new Date());
  const byDay = {};
  for (const a of list) {
    if (!a || !a.createdAt) continue;
    const k = dayKey(new Date(a.createdAt));
    if (!byDay[k]) byDay[k] = { count: 0, seconds: 0 };
    byDay[k].count++;
    byDay[k].seconds += (a.metrics && a.metrics.durationSec) || 0;
  }
  const days = Object.keys(byDay).sort();
  let streak = 0;
  const cursor = new Date(now || new Date());
  if (!byDay[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
  while (byDay[dayKey(cursor)]) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  const totalSec = days.reduce((a, k) => a + byDay[k].seconds, 0);
  return {
    todayCount: (byDay[today] || { count: 0 }).count,
    totalCount: list.length,
    totalMin: Math.round(totalSec / 6) / 10,
    streak,
    activeDays: days.length,
  };
}

// Shared elapsed timer: ticks el every 250ms from a start timestamp.
// Returns stop(). No-ops cleanly without a DOM (tests).
function startElapsedTimer(el, sinceTs) {
  if (!el || typeof setInterval === 'undefined') return () => {};
  const tick = () => {
    try { el.textContent = formatElapsed(Date.now() - sinceTs); } catch (e) { /* ignore */ }
  };
  tick();
  const id = setInterval(tick, 250);
  return () => clearInterval(id);
}

// Race a promise against a timeout. Resolves with { timedOut: true } instead
// of hanging forever — used for vision calls in click handlers, where an
// unbounded await would strand the UI (e.g. Finish never completing because
// a model download stalled).
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).then((value) => ({ timedOut: false, value })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatElapsed, dayKey, dayStats, startElapsedTimer, withTimeout };
}
