// Debate Coach v1 (Days 3–5): training partner, NOT sparring chatbot.
//
// Loop per round: user argues (voice) → opponent identifies the actual
// argument → attacks its weakest component → user responds → coach
// diagnoses the exchange → next drill targets the demonstrated weakness.
//
// Shared TrainingEngine pieces reused unchanged: AttemptRecorder turn
// boundaries, deterministic speech metrics per user turn, coach-engine
// routing (AI/Rules), deterministic compare. New here: motions, opponent
// + diagnosis contracts (LLM with strict validation), and a rules-based
// sparring fallback so the mode works without any LLM key.

const MOTIONS = [
  { id: 'ai-education', motion: 'AI is good for education', context: 'School and university learning.' },
  { id: 'social-media', motion: 'Social media does more harm than good', context: 'Society-wide effects.' },
  { id: 'remote-work', motion: 'Remote work is better than office work', context: 'Productivity and culture.' },
  { id: 'exams', motion: 'Exams are the best way to assess students', context: 'Education assessment.' },
  { id: 'phones-school', motion: 'Phones should be banned in schools', context: 'Classroom policy.' },
  { id: 'veg-diet', motion: 'Everyone should adopt a plant-based diet', context: 'Health and environment.' },
  { id: 'homework', motion: 'Homework should be abolished', context: 'School policy.' },
  { id: 'zoos', motion: 'Zoos should be banned', context: 'Animal welfare.' },
  { id: 'ubi', motion: 'Universal basic income would work', context: 'Economics and policy.' },
  { id: 'space', motion: 'Space exploration is worth public funding', context: 'Science budgets.' },
];

function getMotion(id) {
  return MOTIONS.find((m) => m.id === id) || null;
}

const WEAK_COMPONENTS = ['claim', 'evidence', 'reasoning', 'rebuttal', 'definitions'];

function strList(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`Invalid "${name}": expected ${min}-${max} items.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Invalid "${name}" item.`);
    return item.trim().slice(0, 400);
  });
}

// Opponent contract: { argument: {claim, evidence[], reasoning},
// weakest_component, attack }. The attack is shown to the user as the
// opponent's spoken-style reply.
function validateOpponent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Opponent must be a JSON object.');
  const arg = raw.argument;
  if (!arg || typeof arg !== 'object') throw new Error('Invalid "argument".');
  if (typeof arg.claim !== 'string' || !arg.claim.trim()) throw new Error('Invalid "argument.claim".');
  const evidence = Array.isArray(arg.evidence) ? arg.evidence.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim().slice(0, 400)) : [];
  const reasoning = typeof arg.reasoning === 'string' ? arg.reasoning.trim().slice(0, 400) : '';
  if (!WEAK_COMPONENTS.includes(raw.weakest_component)) {
    throw new Error('Invalid "weakest_component".');
  }
  if (typeof raw.attack !== 'string' || !raw.attack.trim()) throw new Error('Invalid "attack".');
  if (raw.attack.trim().length < 20) throw new Error('Invalid "attack": too short to engage the argument.');
  return {
    argument: { claim: arg.claim.trim().slice(0, 400), evidence, reasoning },
    weakest_component: raw.weakest_component,
    attack: raw.attack.trim().slice(0, 1200),
  };
}

// Diagnosis contract mirrors the speech analyzer so the UI renders both:
// { strengths, areas_to_improve, actionable_feedback,
//   retry_focus: {focus, targets, tip}, scorecard }. Scorecard counts must be
// grounded in the exchange (prompt-enforced); targets reuse speech metric
// keys when the issue is delivery, else debate aspect keys for display.
function validateDiagnosis(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Diagnosis must be a JSON object.');
  const strengths = strList(raw.strengths, 'strengths', 1, 5);
  const areas_to_improve = strList(raw.areas_to_improve, 'areas_to_improve', 1, 5);
  const actionable_feedback = strList(raw.actionable_feedback, 'actionable_feedback', 1, 5);
  const rf = raw.retry_focus;
  if (!rf || typeof rf !== 'object' || Array.isArray(rf)) throw new Error('Invalid "retry_focus".');
  if (typeof rf.focus !== 'string' || !rf.focus.trim()) throw new Error('Invalid "retry_focus.focus".');
  const targets = Array.isArray(rf.targets) ? rf.targets.filter((t) => typeof t === 'string') : [];
  const tip = typeof rf.tip === 'string' ? rf.tip.trim().slice(0, 300) : '';
  const sc = raw.scorecard && typeof raw.scorecard === 'object' ? raw.scorecard : {};
  const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    strengths,
    areas_to_improve,
    actionable_feedback,
    retry_focus: { focus: rf.focus.trim().slice(0, 300), targets, tip },
    scorecard: {
      claims_made: count(sc.claims_made),
      claims_supported: count(sc.claims_supported),
      rebuttals_addressed: count(sc.rebuttals_addressed),
      rounds: count(sc.rounds),
    },
  };
}

// Rules sparring fallback (no LLM): honest stock challenges that rotate.
// These can't diagnose, but they force evidence, definitions, and rebuttals
// — genuinely useful sparring, clearly labeled as rules-based.
const STOCK_CHALLENGES = [
  'What is your single strongest piece of evidence for that — and why should I trust it?',
  'Define your key term precisely. Vague definitions lose debates.',
  'Steel-man my side for a moment: what is the best argument against you, and why does it fail?',
  'Give me one concrete example — names, places, numbers — not an abstraction.',
  'You made a claim about cause and effect. How do you know it is the cause, not just correlated?',
  'Respond directly to my last point. Which part of it is wrong, exactly?',
];

function quotePrefix(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return 'You said "' + (t.length > 120 ? t.slice(0, 120) + '…' : t) + '" — ';
}

// Accepts a bare round number (legacy) or { round, lastUserText }: the stock
// challenge stays fixed, but it now hooks onto the user's actual words, so
// rules sparring follows the conversation instead of ignoring it.
function stockChallenge(roundOrOpts) {
  const o = (roundOrOpts && typeof roundOrOpts === 'object') ? roundOrOpts : { round: roundOrOpts };
  const round = Number(o.round) || 0;
  return quotePrefix(o.lastUserText) + STOCK_CHALLENGES[round % STOCK_CHALLENGES.length];
}

// Deterministic diagnosis fallback: delivery metrics + exchange counts only.
// Never invents argument judgments.
function diagnoseRules({ userTurns, metricsList }) {
  const totalWords = metricsList.reduce((a, m) => a + (m.wordCount || 0), 0);
  const totalFillers = metricsList.reduce((a, m) => a + (m.fillerCount || 0), 0);
  const strengths = [];
  const areas = [];
  if (userTurns.length >= 2) strengths.push(`Sustained across ${userTurns.length} rounds — you kept arguing instead of folding.`);
  if (totalWords >= 60) strengths.push(`Substantive case at ${totalWords} words across ${userTurns.length} rounds.`);
  if (totalFillers === 0 && totalWords > 0) strengths.push('Clean delivery under pressure — zero fillers detected.');
  else if (totalWords > 0) areas.push(`${totalFillers} filler words across the debate — pressure is leaking into your delivery.`);
  if (totalWords > 0 && totalWords < 40) areas.push(`Thin case (${totalWords} words total) — say more: claims need material to stand on.`);
  if (!strengths.length) strengths.push('You showed up and argued — the reps themselves are the training.');
  return {
    strengths: strengths.slice(0, 3),
    areas_to_improve: areas.slice(0, 3),
    actionable_feedback: areas.length
      ? ['Next round, attack with one claim + one piece of evidence + one sentence explaining the link.']
      : ['Raise the difficulty: pick the stronger side against yourself next time.'],
    retry_focus: {
      focus: areas.length ? 'One supported claim per round.' : 'Argue the other side of the same motion.',
      targets: [],
      tip: 'Connect the LLM coach for argument-level diagnosis (claims, evidence, rebuttals).',
    },
    scorecard: { claims_made: 0, claims_supported: 0, rebuttals_addressed: 0, rounds: userTurns.length },
  };
}

module.exports = {
  MOTIONS, getMotion, WEAK_COMPONENTS,
  validateOpponent, validateDiagnosis, stockChallenge, diagnoseRules, STOCK_CHALLENGES,
};
