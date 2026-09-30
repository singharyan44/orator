// On-the-fly practice sample texts (replaces static TTS WAV clips).
//
// Flow: LLM writes fresh sample text per request → browser speaks it aloud
// (speechSynthesis) → the live mic captures it → AssemblyAI transcribes it
// like any real speech. Same Turn pipeline, zero new keys or services.
//
// generateSampleText({ kind, topic, motion, side }, opts) -> { text }
// Throws on any problem (unknown kind, no provider, network, bad shape) and
// the caller falls back to STATIC_SAMPLES. Kinds:
//   speech-weak    — filler-heavy practice answer (~3 sentences)
//   speech-clean   — clean practice answer (~3 sentences)
//   debate-for     — argument FOR the motion (~4 sentences, one vague claim)
//   debate-against — argument AGAINST the motion (~4 sentences)
//   interview-answer — STAR-style interview answer (~3 sentences)

const { getProviderConfig } = require('./llm/provider');
const openrouter = require('./llm/openrouter');
const groq = require('./llm/groq');
const { languageLine, langEntry } = require('./language');

const PROVIDER_MODULES = { openrouter, groq };

const STATIC_SAMPLES = {
  'speech-weak':
    'Um, so like, I think, uh, you know, the movie was, was really, really good, basically. I, I liked it a lot.',
  'speech-clean':
    'My name is Alex and I work as a nurse. I chose this job because I like helping people through difficult days. Last week a patient thanked me, and that reminded me why the work matters.',
  'debate-for':
    'Artificial intelligence is good for education because it personalizes learning for every single student. Studies show students improve a lot when lessons adapt to them. Every school should use it as soon as possible.',
  'debate-against':
    'Artificial intelligence harms education because students stop thinking for themselves. Real learning comes from struggling through hard problems. Depending on machines will only make young minds lazy.',
  'interview-answer':
    'In my last project the release was slipping because testing kept finding late bugs. I proposed freezing features two days early so QA had a clean window. We shipped on time, and the team kept the practice afterwards.',
};

// Second built-in variants so keyless demos (no LLM) don't repeat the same
// text verbatim every turn. Same shape and flaws as the base on purpose:
// debate-for keeps exactly one vague claim for the opponent to attack.
const STATIC_SAMPLES_ALT = {
  'debate-for':
    'Artificial intelligence belongs in every classroom because one teacher cannot adapt to thirty different minds at once. Research suggests personalized pacing lifts results. Schools that refuse it will fall behind.',
  'debate-against':
    'Putting artificial intelligence in classrooms trades deep thinking for quick answers. For example, my cousin copies essay drafts from a chatbot and learns nothing. Convenience today costs understanding tomorrow.',
  'interview-answer':
    'Our team inherited a checkout page that failed one order in twenty. I added logging, found a race between two payment calls, and serialized them. Failures dropped to nearly zero within a week.',
};

const SYSTEM_PROMPT = `You write short spoken practice samples for a voice-coaching app. The text will be read aloud by text-to-speech and transcribed, so write naturally speakable words only: no stage directions, no markdown, no quotes around the whole thing, no lists.

Rules by kind (given in the request):
- speech-weak: 2-4 sentences on the topic, WITH natural filler words (um, uh, like, you know), one repeated word, conversational and slightly rambling. 30-60 words.
- speech-clean: 3-4 clear sentences on the topic, zero fillers, complete sentences. 35-65 words.
- debate-for: 3-4 sentence argument FOR the motion, spoken style, including exactly one vague evidence claim (e.g. "studies show") for the opponent to attack. 40-70 words.
- debate-against: 3-4 sentence argument AGAINST the motion, spoken style, with one concrete example. 40-70 words.
- interview-answer: 3-sentence job interview answer following situation, action, result. Concrete and specific. 35-65 words.

Respond with JSON ONLY, no markdown fences: { "text": "..." }`;

function buildSampleUser({ kind, topic, motion, side, history }) {
  const parts = ['kind: ' + kind];
  if (topic) parts.push('topic: ' + String(topic).slice(0, 300));
  if (motion) parts.push('motion: ' + String(motion).slice(0, 300));
  if (side) parts.push('argue_side: ' + side);
  // Conversational memory (debate + interview): the sample must fit the
  // exchange so far — answer the last question, advance (never repeat)
  // prior points. Speech kinds ignore history (no conversation there).
  const turns = Array.isArray(history) ? history.slice(-6) : [];
  if (turns.length) {
    parts.push('prior_exchanges: ' + JSON.stringify(turns.map((h) => ({
      speaker: String((h && h.speaker) || '?').slice(0, 20),
      text: String((h && h.text) || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    }))));
    parts.push('memory_rules: interview-answer engages the LAST interviewer question directly. debate-for/debate-against advances YOUR side with a NEW point or answers the opponent\'s last attack — never restate an earlier point.');
  }
  return parts.join('\n');
}

function parseJSON(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function validateText(raw) {
  const text = raw && typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text.length < 20 || text.length > 700) throw new Error('Sample text failed validation.');
  return text;
}

async function generateSampleText({ kind, topic, motion, side, history, language }, opts) {
  if (!STATIC_SAMPLES[kind]) throw new Error('Unknown sample kind.');
  const o = opts || {};
  const config = o.config || getProviderConfig(o.env);
  if (!config) throw new Error('No LLM provider configured.');
  if (config.error) throw new Error(config.error);
  const provider = (o.providers || PROVIDER_MODULES)[config.name];
  if (!provider) throw new Error(`No implementation for provider "${config.name}".`);
  const langName = langEntry(language).name;
  const system = SYSTEM_PROMPT + `\nWrite the sample in ${langName} (speakable words in ${langName}).\n` + languageLine(language);
  const text = await provider.complete({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    system,
    user: buildSampleUser({ kind, topic, motion, side, history }),
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
  });
  return { text: validateText(parseJSON(text)), provider: config.name, model: config.model };
}

function staticSample(kind, seed) {
  if (!STATIC_SAMPLES[kind]) throw new Error('Unknown sample kind.');
  // Odd seeds take the alt variant where one exists (keyless variety);
  // even/missing seeds keep the long-standing base text.
  if (STATIC_SAMPLES_ALT[kind] && Number(seed) % 2 === 1) return STATIC_SAMPLES_ALT[kind];
  return STATIC_SAMPLES[kind];
}

module.exports = { generateSampleText, staticSample, buildSampleUser, STATIC_SAMPLES };
