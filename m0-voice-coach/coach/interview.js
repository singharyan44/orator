// Interview Coach (stretch build, same TrainingEngine loop as Debate).
//
// Loop: pick a role → interviewer asks (opener, then adaptive follow-ups:
// clarification → deeper probe → pressure/curveball) → candidate answers by
// voice → diagnose (scorecard + retry focus) → interview again.
// Reuses: AttemptRecorder boundaries, speech metrics per answer, AI/Rules
// routing with truthful fallback, deterministic compare across interviews.

const ROLES = [
  {
    id: 'swe',
    title: 'Software Engineer',
    focus: ['technical decisions', 'debugging stories', 'trade-offs', 'teamwork'],
    opener: 'Tell me about the most challenging bug you have fixed. What made it hard?',
  },
  {
    id: 'pm',
    title: 'Product Manager',
    focus: ['prioritization', 'stakeholders', 'metrics', 'trade-offs'],
    opener: 'Tell me about a time you had to say no to an important stakeholder.',
  },
  {
    id: 'data',
    title: 'Data Analyst',
    focus: ['explaining findings', 'messy data', 'business impact', 'methods'],
    opener: 'Describe an analysis you did that changed a business decision.',
  },
  {
    id: 'marketing',
    title: 'Marketing Manager',
    focus: ['campaigns', 'audiences', 'measuring success', 'creativity'],
    opener: 'Tell me about a campaign that worked — and why you think it worked.',
  },
  {
    id: 'support',
    title: 'Customer Support',
    focus: ['difficult customers', 'empathy', 'problem solving', 'pressure'],
    opener: 'Tell me about the angriest customer you ever helped. What did you do?',
  },
  {
    id: 'general',
    title: 'General / Behavioral',
    focus: ['teamwork', 'failure', 'pressure', 'strengths'],
    opener: 'Tell me about a time you failed at something. What did you learn?',
  },
  {
    id: 'design',
    title: 'UX Designer',
    focus: ['design decisions', 'user research', 'feedback', 'constraints'],
    opener: 'Walk me through a design you shipped that you are proud of. Why those choices?',
  },
  {
    id: 'sales',
    title: 'Sales Representative',
    focus: ['objections', 'targets', 'relationships', 'rejection'],
    opener: 'Tell me about the toughest objection you ever overcame to close a deal.',
  },
  {
    id: 'teacher',
    title: 'Teacher',
    focus: ['difficult students', 'engagement', 'outcomes', 'parents'],
    opener: 'Describe a student who was struggling and what you did about it.',
  },
  {
    id: 'consultant',
    title: 'Consultant',
    focus: ['ambiguous problems', 'clients', 'recommendations', 'impact'],
    opener: 'Tell me about a time you walked into an ambiguous problem with no clear answer.',
  },
];

function getRole(id) {
  return ROLES.find((r) => r.id === id) || null;
}

const INTENTS = ['opener', 'clarification', 'probe', 'pressure', 'curveball'];

function strList(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`Invalid "${name}": expected ${min}-${max} items.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`Invalid "${name}" item.`);
    return item.trim().slice(0, 400);
  });
}

// Interviewer contract: { question, intent }. One question only, grounded in
// the candidate's actual words.
function validateQuestion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Question must be a JSON object.');
  if (typeof raw.question !== 'string' || !raw.question.trim()) throw new Error('Invalid "question".');
  if (raw.question.trim().length < 10) throw new Error('Invalid "question": too short to interview with.');
  if (!INTENTS.includes(raw.intent)) throw new Error('Invalid "intent".');
  return { question: raw.question.trim().slice(0, 600), intent: raw.intent };
}

// Diagnosis contract mirrors the speech analyzer + interview scorecard.
function validateInterviewDiagnosis(raw) {
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
      questions_answered: count(sc.questions_answered),
      concise_answers: count(sc.concise_answers),
      evidence_given: count(sc.evidence_given),
      pressure_handled: count(sc.pressure_handled),
    },
  };
}

// Rules interviewer fallback (no LLM): role-grounded stock questions that
// rotate. Honest labeled sparring — no fake analysis of answers.
const STOCK_FOLLOWUPS = [
  'Can you give me a concrete example of that — what exactly happened?',
  'What was YOUR specific contribution, versus the team’s?',
  'What would you do differently if you faced the same situation tomorrow?',
  'Push back on yourself for a moment: what is the weak spot in that answer?',
  'Give me the short version in two sentences, as if we have thirty seconds left.',
  'What numbers or outcomes prove it worked?',
];

function quotePrefix(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return 'You mentioned "' + (t.length > 120 ? t.slice(0, 120) + '…' : t) + '" — ';
}

// Same shape as debate's stockChallenge: bare round number (legacy) or
// { round, lastAnswer }. Templates stay fixed; the quote hooks them onto
// the candidate's actual answer.
function stockFollowup(roundOrOpts) {
  const o = (roundOrOpts && typeof roundOrOpts === 'object') ? roundOrOpts : { round: roundOrOpts };
  const round = Number(o.round) || 0;
  return quotePrefix(o.lastAnswer) + STOCK_FOLLOWUPS[round % STOCK_FOLLOWUPS.length];
}

// Deterministic diagnosis fallback: delivery metrics + counts only.
function diagnoseInterviewRules({ answers, metricsList }) {
  const totalWords = metricsList.reduce((a, m) => a + (m.wordCount || 0), 0);
  const totalFillers = metricsList.reduce((a, m) => a + (m.fillerCount || 0), 0);
  const strengths = [];
  const areas = [];
  if (answers.length >= 2) strengths.push(`Answered ${answers.length} questions without dodging — you stayed in the hot seat.`);
  if (totalWords >= 60) strengths.push(`Substantive answers at ${totalWords} words — you give interviewers material.`);
  if (totalFillers === 0 && totalWords > 0) strengths.push('Clean delivery under pressure — zero fillers detected.');
  else if (totalWords > 0) areas.push(`${totalFillers} filler words — pressure is leaking into your delivery.`);
  if (totalWords > 0 && totalWords < 40) areas.push(`Thin answers (${totalWords} words total) — interviewers read short answers as thin experience.`);
  if (!strengths.length) strengths.push('You showed up and answered — the reps themselves are the training.');
  return {
    strengths: strengths.slice(0, 3),
    areas_to_improve: areas.slice(0, 3),
    actionable_feedback: ['Structure every answer: what happened, what YOU did, what resulted.'],
    retry_focus: {
      focus: 'One structured answer per question: situation, action, result.',
      targets: [],
      tip: 'Connect the LLM coach for answer-level diagnosis (evidence, conciseness, pressure).',
    },
    scorecard: { questions_answered: answers.length, concise_answers: 0, evidence_given: 0, pressure_handled: 0 },
  };
}

module.exports = {
  ROLES, getRole, INTENTS,
  validateQuestion, validateInterviewDiagnosis,
  stockFollowup, diagnoseInterviewRules, STOCK_FOLLOWUPS,
};
