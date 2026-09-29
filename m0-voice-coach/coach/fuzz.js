// Fuzz harness: every validator/pure module must THROW CLEANLY (never crash
// the process, never hang, never return garbage) on hostile inputs.
// Run: node coach/fuzz.js (exit 1 on process crash only; all else is caught).
const { computeMetrics } = require('./metrics');
const { analyzeAttempt } = require('./analyze');
const { compareAttempts } = require('./compare');
const { buildProfile, skillVerdicts } = require('./profile');
const { assignNext } = require('./assign');
const { validateOpponent, validateDiagnosis, diagnoseRules, stockChallenge } = require('./debate');
const { validateQuestion, validateInterviewDiagnosis, diagnoseInterviewRules, stockFollowup } = require('./interview');
const { validateFeedback } = require('./llm-analyze');
const { sanitizeVisual } = require('./metrics');
const { buildVoiceOpponentPrompt } = require('./voice-opponent');
const { buildHealth } = require('./health');
const { buildSessionText } = require('../public/export-text');
const { AttemptRecorder } = require('../public/attempt-recorder');

const POISON = [null, undefined, 42, 'str', true, [], {}, NaN, Infinity, -1,
  { __proto__: { polluted: true } }, () => {}, new Array(5000).fill('x'),
  'x'.repeat(100000), { a: { b: { c: [1, 2, { d: null }] } } }];

let crashed = false, thrown = 0, returned = 0;
function attempt(name, fn) {
  try {
    fn();
    returned++;
  } catch (e) {
    thrown++;
    if (!e || !e.message) { console.log('WEIRD-THROW', name); crashed = true; }
  }
}

const M = { wordCount: 10, wpm: 120, fillerCount: 0, fillerRatePer100: 0, repeatCount: 0, sentenceCount: 2, avgSentenceLen: 5, longSentenceCount: 0, fragmentCount: 0, hesitationCount: 0, turnCount: 1, avgWordsPerTurn: 10, durationSec: 5, pauseCount: 0, longestPauseMs: 0, totalPauseSec: 0, pausesMeasured: false };
const A = { strengths: ['s'], areas_to_improve: ['a'], actionable_feedback: ['f'], retry_focus: { focus: 'f', targets: [], tip: 't' } };

for (const p of POISON) {
  attempt('metrics', () => computeMetrics(p));
  attempt('metrics-shape', () => computeMetrics({ transcript: p, durationMs: p, turnCount: p, words: p }));
  attempt('analyze', () => analyzeAttempt({ metrics: p }));
  attempt('analyze-shape', () => analyzeAttempt({ metrics: M }));
  attempt('compare', () => compareAttempts(p, { metrics: M, retry_focus: { focus: 'f', targets: [], tip: '' } }, p && p.retry_focus));
  attempt('profile', () => buildProfile(p));
  attempt('skillVerdicts', () => skillVerdicts(p));
  attempt('assign', () => assignNext(p, p));
  attempt('validateOpponent', () => validateOpponent(p));
  attempt('validateDiagnosis', () => validateDiagnosis(p));
  attempt('diagnoseRules', () => diagnoseRules({ userTurns: p, metricsList: p }));
  attempt('stockChallenge', () => stockChallenge(p));
  attempt('validateQuestion', () => validateQuestion(p));
  attempt('validateInterviewDiagnosis', () => validateInterviewDiagnosis(p));
  attempt('diagnoseInterviewRules', () => diagnoseInterviewRules({ answers: p, metricsList: p }));
  attempt('stockFollowup', () => stockFollowup(p));
  attempt('validateFeedback', () => validateFeedback(p));
  attempt('sanitizeVisual', () => sanitizeVisual(p));
  attempt('voicePrompt', () => buildVoiceOpponentPrompt(p, p));
  attempt('health', () => buildHealth(p));
  attempt('exportText', () => buildSessionText(p));
  attempt('recorder', () => {
    const r = new AttemptRecorder();
    r.start(0);
    r.onTurn(p);
    r.finish(p);
  });
}

// Targeted abuse shapes (must throw cleanly, never hang/crash).
attempt('metrics-huge', () => computeMetrics({ transcript: 'w '.repeat(200000), durationMs: 1e12, turnCount: 1e9 }));
attempt('assign-huge', () => assignNext(new Array(500).fill({ metrics: M, analysis: A }), null));
attempt('profile-huge', () => buildProfile(new Array(500).fill({ metrics: M, analysis: A })));
attempt('recorder-flood', () => {
  const r = new AttemptRecorder();
  r.start(0);
  for (let i = 0; i < 2000; i++) r.onTurn({ text: 'x', final: false, order: i });
  r.finish(1);
});
attempt('compare-missing', () => compareAttempts({ metrics: {} }, { metrics: {} }, null));

console.log(`FUZZ done: returned=${returned} threw-cleanly=${thrown} crashed=${crashed}`);
console.log('polluted?', ({}).polluted === true ? 'YES-BAD' : 'no');
process.exit(crashed || ({}).polluted === true ? 1 : 0);
