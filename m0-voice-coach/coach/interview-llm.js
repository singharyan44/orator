// LLM layer for Interview Coach. Same provider abstraction (server-side,
// single non-streamed request). Strict contracts validated by
// coach/interview.js. Any failure throws → caller falls back.

const { getProviderConfig } = require('./llm/provider');
const openrouter = require('./llm/openrouter');
const groq = require('./llm/groq');
const { validateQuestion, validateInterviewDiagnosis } = require('./interview');
const { languageLine } = require('./language');

const PROVIDER_MODULES = { openrouter, groq };

function parseJSON(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function short(text, max) {
  const t = String(text || '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

async function callLLM({ system, user, opts }) {
  const o = opts || {};
  const config = o.config || getProviderConfig(o.env);
  if (!config) throw new Error('No LLM provider configured.');
  if (config.error) throw new Error(config.error);
  const provider = (o.providers || PROVIDER_MODULES)[config.name];
  if (!provider) throw new Error(`No implementation for provider "${config.name}".`);
  const text = await provider.complete({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    system,
    user,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
  });
  return { text, config };
}

const INTERVIEWER_SYSTEM = `You are a job interviewer running a practice interview. You ask sharp, realistic interview questions — one at a time.

STRICT RULES:
- Your question must engage the candidate's ACTUAL last answer: quote or closely paraphrase their words. Never generic "tell me more".
- Escalate naturally across rounds: early rounds clarify, middle rounds probe deeper, later rounds add pressure (challenge an assumption, introduce a curveball or constraint).
- The first question (no prior answer) opens on the role's focus areas.
- One question only, spoken style, under 40 words.
- Never judge accent, intelligence, or personality. Never comment on voice, emotion, or body language.
- Respond with JSON ONLY, no markdown fences, exactly this shape:
{
  "question": "...",
  "intent": "opener | clarification | probe | pressure | curveball"
}`;

async function interviewerNext({ role, lastAnswer, history, round, language }, opts) {
  const user = JSON.stringify({
    role: role.title,
    focus_areas: role.focus,
    round: round,
    last_answer: lastAnswer ? short(lastAnswer, 1200) : null,
    prior_exchanges: (history || []).slice(-6).map((h) => ({ speaker: h.speaker, text: short(h.text, 600) })),
  });
  const { text, config } = await callLLM({ system: INTERVIEWER_SYSTEM + '\n' + languageLine(language), user, opts });
  const validated = validateQuestion(parseJSON(text));
  return { ...validated, provider: config.name, model: config.model };
}

const INTERVIEW_DIAGNOSIS_SYSTEM = `You are an interview coach diagnosing a completed practice interview. You receive the role, the full exchange, and measured delivery metrics per candidate answer.

STRICT RULES:
- Ground every claim in the exchange or metrics. Never invent answers, quotes, or numbers.
- "scorecard" counts must reflect what happened: questions_answered (use the exact number given), concise_answers (answers under ~60 words that still answer), evidence_given (answers with a concrete example, number, or outcome), pressure_handled (times the candidate answered a pressure/curveball question directly).
- Distinguish measured delivery facts from answer-quality interpretation.
- Give ONE clear retry focus. "targets" may name speech metric keys (wpm, fillerRatePer100, repeatCount, wordCount) for delivery issues, or interview keys (conciseness, evidence, structure, pressure) for answer issues.
- Never judge accent, intelligence, or personality. Never claim voice/emotion/body-language measurement. Never issue hire/no-hire verdicts — coach the skill, not the outcome.
- Respond with JSON ONLY, no markdown fences, exactly this shape:
{
  "strengths": ["..."],
  "areas_to_improve": ["..."],
  "actionable_feedback": ["..."],
  "retry_focus": { "focus": "...", "targets": ["..."], "tip": "..." },
  "scorecard": { "questions_answered": 0, "concise_answers": 0, "evidence_given": 0, "pressure_handled": 0 }
}
1-3 items per list. Each item under 200 characters.`;

async function diagnoseInterview({ role, exchanges, delivery, language }, opts) {
  const user = JSON.stringify({
    role: role.title,
    questions_answered: exchanges.filter((e) => e.speaker === 'candidate').length,
    exchanges: (exchanges || []).map((e) => ({ speaker: e.speaker, text: short(e.text, 700) })),
    delivery_per_answer: delivery || [],
  });
  const { text, config } = await callLLM({ system: INTERVIEW_DIAGNOSIS_SYSTEM + '\n' + languageLine(language), user, opts });
  const validated = validateInterviewDiagnosis(parseJSON(text));
  return { ...validated, provider: config.name, model: config.model };
}

module.exports = { interviewerNext, diagnoseInterview };
