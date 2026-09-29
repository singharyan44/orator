// Personal training profile (Day 1: profile lite).
//
// Aggregates a history of attempts into a communication profile:
// strengths, recurring weaknesses, current focus, and metric trends.
// Pure and deterministic — free-text feedback is NEVER matched by string;
// skills are re-derived from each attempt's measured metrics, and the retry
// focus is aggregated via its machine-readable `targets` (metric keys).
//
// Input attempts: [{ promptTitle, transcript, metrics, analysis, createdAt }]
// (analysis only needs retry_focus.targets; everything else comes from metrics.)

const SKILLS = [
  { key: 'pace', label: 'Steady pace' },
  { key: 'fillers', label: 'Clean delivery' },
  { key: 'repeats', label: 'No restarts' },
  { key: 'structure', label: 'Complete sentences' },
  { key: 'substance', label: 'Full answers' },
  { key: 'pauses', label: 'No hesitation pauses' },
  { key: 'presence', label: 'Camera presence' },
];

// Per-attempt skill verdicts from measured metrics only.
// Returns { pace: true|false|null, ... } (null = not measurable).
function skillVerdicts(m) {
  if (!m) return { pace: null, fillers: null, repeats: null, structure: null, substance: null, pauses: null, presence: null };
  return {
    pace: m.wpm == null ? null : (m.wpm >= 100 && m.wpm <= 170),
    fillers: (m.fillerRatePer100 || 0) <= 3,
    repeats: (m.repeatCount || 0) === 0,
    structure: (m.fragmentCount || 0) === 0 && (m.longSentenceCount || 0) === 0,
    substance: (m.wordCount || 0) >= 20,
    // Unknown (not bad) when no word timings / camera data existed.
    pauses: m.pausesMeasured ? (m.pauseCount || 0) === 0 : null,
    presence: m.visualMeasured && m.visual ? (m.visual.faces === m.visual.frames && m.visual.frames > 0) : null,
  };
}

function buildProfile(attempts) {
  const list = (attempts || []).filter((a) => a && a.metrics);
  const counts = {};
  for (const s of SKILLS) counts[s.key] = { good: 0, total: 0 };
  const targetCounts = {};
  const trends = [];

  list.forEach((a, idx) => {
    const v = skillVerdicts(a.metrics);
    for (const s of SKILLS) {
      if (v[s.key] !== null) {
        counts[s.key].total++;
        if (v[s.key]) counts[s.key].good++;
      }
    }
    const targets = (a.analysis && a.analysis.retry_focus && a.analysis.retry_focus.targets) || [];
    for (const t of targets) {
      if (typeof t === 'string') targetCounts[t] = (targetCounts[t] || 0) + 1;
    }
    trends.push({
      n: idx + 1,
      wpm: a.metrics.wpm,
      fillerRatePer100: a.metrics.fillerRatePer100,
      repeatCount: a.metrics.repeatCount,
      wordCount: a.metrics.wordCount,
      createdAt: a.createdAt || null,
    });
  });

  const skills = SKILLS.map((s) => {
    const { good, total } = counts[s.key];
    const rate = total > 0 ? good / total : null;
    return {
      key: s.key,
      label: s.label,
      good,
      total,
      status: rate === null ? 'unknown' : rate >= 0.6 ? 'strength' : rate <= 0.4 ? 'weakness' : 'developing',
    };
  });

  let topFocus = null;
  const ranked = Object.entries(targetCounts).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) topFocus = { target: ranked[0][0], times: ranked[0][1] };

  const times = list.map((a) => a.createdAt).filter(Boolean).sort();
  return {
    totalAttempts: list.length,
    firstAttemptAt: times.length ? times[0] : null,
    lastAttemptAt: times.length ? times[times.length - 1] : null,
    skills,
    strengths: skills.filter((s) => s.status === 'strength'),
    recurringWeaknesses: skills.filter((s) => s.status === 'weakness'),
    topFocus,
    trends,
    promptsPracticed: [...new Set(list.map((a) => a.promptTitle).filter(Boolean))],
  };
}

module.exports = { buildProfile, skillVerdicts, SKILLS };
