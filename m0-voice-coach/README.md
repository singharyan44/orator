# Voice Coach — adaptive communication training

One training loop, three coaches: **Speech** (prompts → feedback → retry →
comparison), **Debate** (argue → opponent attacks your weakest point →
diagnose → rematch), **Interview** (adaptive interviewer → pressure rounds →
diagnosis). The system tracks your profile across sessions and assigns the
next exercise targeting your weakest skill.

Loop: Challenge → Speak → Observe → Diagnose → Coach → Retry →
Measure improvement → Adapt. See [ARCHITECTURE.md](../../ARCHITECTURE.md)
and [DEMO.md](../../DEMO.md).

Transport: browser mic → 16 kHz mono PCM16 → AssemblyAI Universal-3.5 Pro
Streaming → interim/final Turn events (+ word timings, optional camera,
optional spoken debate opponent via the Voice Agent API).

## Setup (no coding needed)

```
cp .env.example .env
# Edit .env and set ASSEMBLYAI_API_KEY
npm install
npm start
```

Open http://localhost:3000 (Chrome or Edge recommended).

## How to practice

1. Read the practice prompt, or press **New prompt** for another one.
2. Press **Connect** and allow microphone access.
3. Press **Start attempt** and speak.
4. Watch the live transcript as you talk.
5. Press **Finish attempt** — your speech is analyzed and feedback appears.
6. Press **Try again**, speak a second time, press **Finish attempt**.
7. Read the comparison: what improved, what stayed the same, what got worse,
   and what to focus on next.

## Hands-free testing (no mic needed)

Sample buttons generate fresh speech on demand and play it aloud through
your speakers — your live mic captures it like real speech, so the full
loop (transcript → analysis → retry → comparison) works without speaking:

1. Connect, then press **Start attempt** (or **Speak argument** in Debate).
2. Play a sample: filler-heavy / clean retry, or a debate argument written
   for your current side and motion.
3. Wait for the final transcript, press **Finish**.

Sample texts are written per request by the configured LLM (`POST
/api/sample-text`, static fallback included) and spoken with built-in
browser TTS. Sound must be on; no mic audio is replaced in normal use.

## What it does

- Temporary streaming token from `/token` (API key stays server-side)
- Live interim + finalized transcripts over the streaming WebSocket
- Each attempt records transcript, duration, and turn count
- Rule-based coaching analysis (no LLM key needed): measured metrics
  (pace, fillers, repeats, sentence structure) plus grounded strengths,
  fixes, and one retry focus — never generic praise
- Attempt comparison with noise bands (tiny wobbles report "same")
- Clean disconnect sends `{"type":"Terminate"}` to close the session

## Coaching API (stateless — safe on serverless hosts)

Each request carries everything it needs; the server keeps memory only as a
local-dev convenience:

- `POST /api/sessions` → `{ sessionId, prompt }`
- `POST /api/sessions/:id/attempts` `{ transcript, durationMs, turnCount, coachEngine, previous? }`
  → `{ attempt, analysis, coachSource, requestedEngine, comparison? }`
  (`comparison` is included inline from attempt 2 on; `previous` is the last
  attempt the browser already holds, so retries survive across instances)
- `GET /api/sessions/:id/comparison` → same comparison (local-dev fallback)

## LLM coaching (optional)

Without LLM configuration, M1 uses the built-in deterministic coach and the
feedback panel shows "Offline coach". To enable AI coaching, set in `.env`:

```
COACH_PROVIDER=openrouter   # or groq
COACH_MODEL=openrouter/free # any model id the provider supports
OPENROUTER_API_KEY=...
GROQ_API_KEY=...
```

Only the key for the selected provider is needed. The model receives the
practice prompt, the finalized transcript, and deterministic metrics — never
microphone audio. If the provider call fails for any reason, the attempt
automatically falls back to the deterministic coach. Attempt comparison always
stays deterministic regardless of provider.

Important: `COACH_MODEL` must be a model id valid for the selected provider
(model ids are provider-specific). If you switch `COACH_PROVIDER`, either
update `COACH_MODEL` to match or remove it to use the provider default
(OpenRouter: `openrouter/free`, Groq: `openai/gpt-oss-20b`). A mismatched model
id fails cleanly into the Rules Coach fallback. Note that OpenRouter free
models can be slow or temporarily unavailable; the fallback covers that too.

## Camera (on-device measurement, optional)

Enable the camera to measure gaze and presence per attempt with MediaPipe
face landmarks, running 100% in your browser: no API key, no quota, no
uploads. Each attempt records head direction (center/left/right),
gaze level, and eye openness; the summary (counts only, never images) joins
the attempt metrics and powers feedback like "looking down in 2 of 3
frames". Devices panel lets you pick microphone and camera; the vision
self-test button verifies the models load without needing a face.

## Docs referenced

- https://www.assemblyai.com/docs/streaming (quickstart, temp tokens, WebSocket API)

## How deeply AssemblyAI is used

- Universal-3.5 Pro Streaming over a single WebSocket (16 kHz mono PCM16,
  fixed ~100 ms binary frames per the 50–1000 ms rule, real-time pacing).
- Server-minted single-use tokens; the API key never reaches the browser.
- Interim + finalized Turn handling with `turn_order` guards and clean
  `Terminate` shutdowns.
- **Word-level timings** from every final Turn drive measured hesitation-pause
  detection (gaps ≥ 700 ms within a turn) — the only pause metric in the app,
  and it comes from the API, not heuristics.

## Debate Coach (training partner, not sparring bot)

Pick a motion + side, argue out loud round by round. After each round the
opponent identifies your actual argument and attacks its weakest component
(unsupported claim, weak evidence, broken reasoning, vague definitions, or
an unanswered rebuttal). Diagnose the debate for a scorecard (claims made /
supported, rebuttals answered) plus a retry focus, then rematch with sides
swapped. Same engine as Speech: AssemblyAI turns, deterministic delivery
metrics, AI/Rules selector with truthful fallback. Without an LLM key the
opponent spars with rotating stock challenges (clearly labeled).

- `GET /api/debate/motions`
- `POST /api/debate/opponent` → `{ attack, weakestComponent, argument, source, metrics }`
- `POST /api/debate/diagnose` → `{ diagnosis, source, delivery? }`
  (`answers` accepted instead of precomputed `delivery`; per-answer metrics
  are computed server-side and returned for history)

## Voice debate opponent (spoken, Voice Agent API)

The Debate arena offers a **Voice** opponent alongside Text: a live
AssemblyAI voice session configured with the debate persona argues out loud
(mic → voice agent → spoken replies, interruption works both ways).
Transcripts feed the same diagnose endpoint — measurement stays on the
analysis side, conversation on the voice side.

- `GET /api/voice-token` (server-side key, single-use token)
- `POST /api/debate/voice-config` → `{ system_prompt, greeting }`

## Interview Coach (adaptive interviewer, same engine)

Pick a role (6 built-in), answer the opener and adaptive follow-ups
(clarification → probe → pressure) out loud, then diagnose: scorecard
(answered / concise / evidenced / pressure handled) plus retry focus, with
optional cross-interview delivery comparison. Rules fallback asks
role-grounded stock questions, clearly labeled.

- `GET /api/interview/roles`
- `POST /api/interview/question` → `{ question, intent, source, metrics }`
- `POST /api/interview/diagnose` → `{ diagnosis, source, comparison? }`
