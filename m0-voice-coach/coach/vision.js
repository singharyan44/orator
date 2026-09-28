// Vision frame screener (multimodal stage 1 of 2).
//
// Pipeline: cheap vision model reviews the attempt's camera frames and
// returns { best_frames, notes } — plainly observable facts only. The main
// coach (text LLM over transcript+metrics) runs IN PARALLEL (see
// coach-engine.js) and the notes merge into its analysis. Either side may
// fail independently; missing pieces degrade to the standard chain.
//
// Honesty rules (prompt-enforced + validated): notes describe only what is
// plainly visible ("looking down at notes in 2 of 3 frames"). NEVER emotion,
// confidence, nervousness, engagement, personality, or body-language quality
// judgments. Unusable frames → say so, no other notes.
// Faces are analyzed then discarded: never stored client- or server-side.

const DEFAULT_VISION_MODEL = 'qwen/qwen3.8-27b:free';

function getVisionConfig(env) {
  const e = env || process.env;
  // Vision routes via OpenRouter (Groq is text-only). Any vision-capable
  // model id works via COACH_VISION_MODEL. Free shared pools rate-limit
  // often — the chain falls back cleanly; adding your own provider key
  // (OpenRouter integrations) or a paid model id fixes quota permanently.
  const apiKey = e.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return {
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    model: e.COACH_VISION_MODEL || DEFAULT_VISION_MODEL,
  };
}

const SCREENER_SYSTEM = `You review up to 4 camera frames from a voice-practice attempt and pick the informative ones. You do NOT coach — a separate coach handles that.

STRICT RULES:
- "best_frames": indices (0-based, in the order given) of frames that clearly show the speaker. Skip dark, blurry, or empty frames.
- "notes": 0-3 short plainly-observable facts about the VISIBLE frames only (e.g. "looking down at notes in 2 of 3 frames", "face not visible in frame 1", "holding papers"). Each under 150 characters.
- NEVER infer emotion, confidence, nervousness, engagement, personality, or body-language quality. NEVER judge appearance.
- If no frame is usable, return best_frames [] and notes ["No usable frames — too dark or blurry to observe anything."].
- Respond with JSON ONLY, no markdown fences: { "best_frames": [0], "notes": ["..."] }`;

function validateScreen(raw, frameCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Screen must be a JSON object.');
  const ids = Array.isArray(raw.best_frames) ? raw.best_frames : [];
  const best_frames = ids.filter((i) => Number.isInteger(i) && i >= 0 && i < frameCount);
  const notesRaw = Array.isArray(raw.notes) ? raw.notes : [];
  if (notesRaw.length > 3) throw new Error('Invalid "notes": at most 3 items.');
  const notes = notesRaw.map((n) => {
    if (typeof n !== 'string' || !n.trim()) throw new Error('Invalid "notes" item.');
    return n.trim().slice(0, 300);
  });
  return { best_frames, notes };
}

function parseJSON(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function buildScreenMessages(frames) {
  const content = [{
    type: 'text',
    text: `Review these ${frames.length} camera frames from a voice-practice attempt (in order).`,
  }];
  for (const f of frames) {
    content.push({ type: 'image_url', image_url: { url: f } });
  }
  return [{ role: 'user', content }];
}

async function screenFrames({ frames }, opts) {
  const o = opts || {};
  const config = o.config || getVisionConfig(o.env);
  if (!config) throw new Error('No vision provider configured.');
  if (config.error) throw new Error(config.error);
  const clean = (frames || []).filter((f) => typeof f === 'string' && f.startsWith('data:image/') && f.length <= 400000);
  if (clean.length === 0) throw new Error('No usable frames.');
  const fetchFn = o.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs || 90000);
  try {
    const res = await fetchFn(config.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey,
        'HTTP-Referer': 'https://localhost:3000/',
        'X-Title': 'Voice Coach M1',
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildScreenMessages(clean),
        temperature: 0.2,
        max_tokens: 1500,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vision provider HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!text || typeof text !== 'string') throw new Error('Vision provider returned no message content.');
    const validated = validateScreen(parseJSON(text), clean.length);
    return { ...validated, provider: config.name, model: config.model };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  screenFrames, buildScreenMessages, validateScreen,
  getVisionConfig, DEFAULT_VISION_MODEL,
};
