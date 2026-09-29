// Measured speech metrics derived from a finalized transcript + timing.
// Everything here is computed from observable data only:
//   - transcript text (AssemblyAI finalized Turns joined together)
//   - durationMs (wall-clock time of the attempt, measured client-side)
//   - turnCount (how many finalized Turns the attempt contained)
//
// Nothing here claims to measure confidence, pitch, emotion, or body language.

const FILLERS = [
  'um', 'uh', 'er', 'ah', 'hmm', 'huh',
  'like', 'basically', 'actually', 'literally',
  'you know', 'i mean', 'kind of', 'sort of', 'let me think',
];

// A silence gap between two AssemblyAI word timings counts as a hesitation
// pause at 700 ms+. Gaps are measured WITHIN one final turn only: cross-turn
// silence includes endpointing delay, which is not the speaker pausing.
const PAUSE_GAP_MS = 700;

function pauseStats(wordGroups) {
  let pauseCount = 0;
  let longestPauseMs = 0;
  let totalPauseMs = 0;
  for (const group of wordGroups || []) {
    if (!Array.isArray(group)) continue;
    const words = group
      .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end;
      if (gap >= PAUSE_GAP_MS) {
        pauseCount++;
        totalPauseMs += gap;
        if (gap > longestPauseMs) longestPauseMs = gap;
      }
    }
  }
  return { pauseCount, longestPauseMs: Math.round(longestPauseMs), totalPauseSec: Math.round(totalPauseMs / 100) / 10 };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPunct(token) {
  return token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '');
}

function splitSentences(text) {
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return matches
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => ({
      text: s,
      words: s.split(/\s+/).filter(Boolean).length,
      terminated: /[.!?]$/.test(s),
    }));
}

function computeMetrics({ transcript, durationMs, turnCount, words, visual }) {
  const text = (transcript || '').trim();
  const lower = text.toLowerCase();
  const rawTokens = text.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map(stripPunct).filter(Boolean);
  const wordCount = tokens.length;

  const durationSec = durationMs > 0 ? durationMs / 1000 : 0;
  const wpm = durationSec > 0 && wordCount > 0 ? Math.round(wordCount / (durationSec / 60)) : null;

  // Filler words/phrases (approximate: "like" etc. have legitimate uses).
  const fillersFound = [];
  let fillerCount = 0;
  for (const phrase of FILLERS) {
    const re = new RegExp('\\b' + escapeRegExp(phrase) + '\\b', 'gi');
    const hits = lower.match(re);
    if (hits) {
      fillerCount += hits.length;
      fillersFound.push({ phrase, count: hits.length });
    }
  }
  fillersFound.sort((a, b) => b.count - a.count);
  const fillerRatePer100 = wordCount > 0 ? Math.round((fillerCount / wordCount) * 1000) / 10 : 0;

  // Consecutive repeated words ("I I", "the the") — a restart signal.
  let repeatCount = 0;
  const repeatExamples = [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() === tokens[i - 1].toLowerCase()) {
      repeatCount++;
      if (repeatExamples.length < 3) repeatExamples.push(tokens[i - 1] + ' ' + tokens[i]);
    }
  }

  const sentences = splitSentences(text);
  const longSentenceCount = sentences.filter((s) => s.words > 25).length;
  const fragmentCount = sentences.filter((s) => s.words < 5 && !s.terminated).length;
  const avgSentenceLen = sentences.length > 0
    ? Math.round((wordCount / sentences.length) * 10) / 10
    : 0;

  // Literal hesitation markers in the text (rare in formatted transcripts; may be 0).
  const hesitationCount = (text.match(/--|\.\.\.|…/g) || []).length;

  const safeTurnCount = Number.isFinite(turnCount) && turnCount > 0 ? Math.floor(turnCount) : 0;
  const avgWordsPerTurn = safeTurnCount > 0 ? Math.round((wordCount / safeTurnCount) * 10) / 10 : 0;

  // On-device visual measurements (pose-est.js landmark geometry), attached
  // when the browser sends them. Sanitized: counts clamped to frames.
  const vis = sanitizeVisual(visual);

  // Measured hesitation pauses from AssemblyAI word timings (not guessed).
  const wordGroups = Array.isArray(words) ? words : [];
  const pauses = pauseStats(wordGroups);

  return {
    durationSec: Math.round(durationSec * 10) / 10,
    wordCount,
    wpm,
    fillerCount,
    fillerRatePer100,
    fillersFound,
    repeatCount,
    repeatExamples,
    sentenceCount: sentences.length,
    avgSentenceLen,
    longSentenceCount,
    fragmentCount,
    hesitationCount,
    turnCount: safeTurnCount,
    avgWordsPerTurn,
    pauseCount: pauses.pauseCount,
    longestPauseMs: pauses.longestPauseMs,
    totalPauseSec: pauses.totalPauseSec,
    // False for old records without word timings: callers must not present
    // pause verdicts as measured when no timing data existed.
    pausesMeasured: wordGroups.length > 0,
    visual: vis,
    // Same honesty rule as pauses: no landmark data → no visual claims.
    visualMeasured: vis !== null,
  };
}

// Sanitize client-computed visual summaries: integers, counts clamped to
// the frame count, null when unusable. Never throws.
function sanitizeVisual(v) {
  try {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const n = (x) => (Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0);
    const frames = Math.min(10, n(v.frames));
    if (!frames) return null;
    const clamp = (x) => Math.min(frames, n(x));
    const timeline = Array.isArray(v.timeline)
      ? v.timeline.slice(0, 12).filter((t) => typeof t === 'string').map((t) => t.slice(0, 30))
      : [];
    return {
      frames,
      faces: clamp(v.faces),
      lookingDown: clamp(v.lookingDown),
      headTurned: clamp(v.headTurned),
      eyesClosed: clamp(v.eyesClosed),
      timeline,
    };
  } catch (e) {
    return null;
  }
}

module.exports = { computeMetrics, sanitizeVisual, FILLERS, PAUSE_GAP_MS };
