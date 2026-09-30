// Response language selection for all AI voices (opponent, interviewer,
// samples, diagnoses, voice agent). The browser sends a `language` code with
// each AI request; the server normalizes it here and each prompt appends a
// language line via languageLine(). Unknown/missing codes fall back to
// English — never throw on a UI preference.
//
// Honest scope note: this covers AI-generated text only. Deterministic
// rules fallbacks (stock challenges, stock follow-ups, static samples) are
// fixed strings and stay in their authored language; the UI labels them and
// says so next to the selector.

const LANGS = [
  { code: 'en', name: 'English', tts: 'en-US' },
  { code: 'de', name: 'German', tts: 'de-DE' },
  { code: 'fr', name: 'French', tts: 'fr-FR' },
  { code: 'es', name: 'Spanish', tts: 'es-ES' },
  { code: 'it', name: 'Italian', tts: 'it-IT' },
  { code: 'pt', name: 'Portuguese', tts: 'pt-PT' },
  { code: 'hi', name: 'Hindi', tts: 'hi-IN' },
];

function normalizeLang(raw) {
  const code = String(raw || '').trim().toLowerCase().slice(0, 2);
  return LANGS.some((l) => l.code === code) ? code : 'en';
}

function langEntry(code) {
  const c = normalizeLang(code);
  return LANGS.find((l) => l.code === c);
}

// One prompt line appended to a system prompt. Pins the VALUES language
// while keeping JSON KEYS exactly as specified, so validators keep working
// in every language.
function languageLine(code) {
  const entry = langEntry(code);
  return `Reply in ${entry.name}. All JSON field VALUES in ${entry.name}; JSON keys stay exactly as specified.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LANGS, normalizeLang, langEntry, languageLine };
}
