# M1 Plan — First Real Orator Loop

Goal: Prompt → Speak → Live transcript → Final transcript → Attempt →
Analysis → Feedback → Retry → Comparison → Next focus.

M0 (streaming transport) is verified working and stays untouched except where
M1 must hook into it.

## Bug 1 (found in live browser test, fixed)

- [x] Finish could submit before pending final Turns arrived. Fixed with
      `public/attempt-recorder.js` state machine (idle → recording →
      finishing → submitted): Finish waits for the next end_of_turn boundary
      when one is pending, submits immediately when the last Turn was already
      final. No timeouts; turn_order guard excludes stale pre-Start finals;
      double-finish cannot resubmit. 20 race tests in `coach/tests.js` (`node
      coach/tests.js`), all passing alongside the 24 pre-existing assertions.

## M0 inventory (reuse as-is)

- [x] `server/index.js` — Express static + `GET /token` (streaming token, key server-side)
- [x] `public/pcm-processor.js` — 16 kHz mono PCM16, fixed ~100 ms chunks (50–1000 ms rule)
- [x] `public/script.js` — mic → binary frames → `Begin`/`Turn`/`Termination`, `Terminate` on close
- [x] `public/index.html` / `style.css` — status, connect btn, transcript boxes, log
- [x] `script.js` inline-worklet fallback still uses old per-frame emits — update to
      match `pcm-processor.js` chunking so the fallback can't regress error 3007

## M1 new components (`coach/`, server-side, zero new dependencies)

- [x] `coach/prompts.js` — small list of practice objectives + picker
- [x] `coach/session.js` — in-memory store: Session → Prompt → Attempt[] (M2 persistence hook)
- [x] `coach/metrics.js` — measured metrics from {transcript, durationMs, turnCount}:
      duration, words, wpm, fillers (+rate), consecutive repeats, long sentences,
      fragments, hesitation markers. All labeled measured/approximate.
- [x] `coach/analyze.js` — rule-based analyzer behind a swappable
      `analyzeAttempt(attemptData)` interface (LLM provider can replace it later).
      Output: `{ strengths, areas_to_improve, actionable_feedback, retry_focus }`
      where `retry_focus = { focus, targets:[metricKeys], tip }`. No generic praise;
      every item grounded in a number.
- [x] `coach/compare.js` — `compareAttempts(prev, curr, prevRetryFocus)` →
      `{ improved[], same[], worse[], retry_focus_addressed, next_focus }`
      with noise bands so tiny deltas report "same", never invented numbers.
      (One real bug found by the harness — wrong verdict-bucket indexing — fixed.)

## Server API (additive only, keep `/token` behavior)

- [x] `express.json()` body parsing
- [x] `GET /api/prompt` → `{ prompt }` — NOTE: shipped as `POST /api/sessions`
      (creates session + assigns prompt in one call; simpler for the client)
- [x] `POST /api/sessions` → `{ sessionId, prompt }`
- [x] `POST /api/sessions/:id/attempts` `{ transcript, durationMs, turnCount }`
      → `{ attempt, analysis }` (validates non-empty transcript)
- [x] `GET /api/sessions/:id/comparison` → comparison of last two attempts
      (400 unless ≥2 attempts)

## UI (additive, no redesign)

- [x] Prompt card + `New prompt` (session start)
- [x] Attempt controls: `Start attempt` (needs connection) → `Finish attempt`
- [x] Attempt accumulator: finalized Turns (`end_of_turn=true`) joined while recording
- [x] Feedback panel rendering structured analysis (metrics + strengths + fixes + retry focus)
- [x] `Try again` button → attempt 2 → comparison panel (improved / same / worse / next focus)
- [x] Empty-attempt guard (don't POST silence)
- [x] Keep Disconnect → `Terminate` path intact

## Validation (no live mic available here — browser test is the user's)

- [x] `node --check` on every JS file
- [x] Unit harness: metrics on sample transcripts (fillers, repeats, wpm math) — 25/25 pass
- [x] Unit harness: analyzer output shape (`strengths`, `areas_to_improve`,
      `actionable_feedback`, `retry_focus`) on weak + strong samples
- [x] Unit harness: comparison verdicts (improved/same/worse + focus-addressed true/false)
- [x] Unit harness: session store transitions (create → attempt1 → attempt2 → comparison gating)
- [x] Server boots; `/token` still returns a token; new API endpoints respond (curl):
      session → attempt1 → attempt2 → comparison all 200; unknown session 404;
      empty transcript 400; early comparison 400
- [x] Static review: no secrets in client, no pcm-processor regression, no M1 scope creep
- [x] MANUAL (user): full Prompt → Attempt → Feedback → Retry → Comparison loop in browser

## M1 LLM coaching (added after Bug 1 fix)

- [x] `coach/llm/provider.js` — env-based selection (openrouter/groq), null when unconfigured
- [x] `coach/llm/chat.js` + `openrouter.js` + `groq.js` — single non-streamed
      OpenAI-compatible request, keys server-side only
- [x] `coach/llm-analyze.js` — same analyzer contract; strict JSON validation;
      throws on any failure so the server falls back to deterministic rules
- [x] Server attempts endpoint tries LLM (with previous-attempt context on retry),
      falls back to rules; response carries `coachSource: 'llm'|'rules'` shown as
      a small badge in the feedback panel
- [x] `compare.js` stays deterministic; LLM never overrides numeric verdicts
- [x] `.env.example` + README document `COACH_PROVIDER`/`COACH_MODEL`/`*_API_KEY`
- [x] Tests: config permutations, input builder (first vs retry), validation
      accepts/rejects, unconfigured/malformed/HTTP-500/network-failure fallback,
      mocked OpenRouter success — `node coach/tests.js` 60/60 pass
## M1 coach engine selector (Speech Coach stays the only product mode)

- [x] `Coach Engine` radio group (AI Coach default checked, Rules Coach) visible
      before recording; disabled while recording/finishing; preserved on retry
- [x] `coach/coach-engine.js` routes per attempt: rules → deterministic only
      (LLM never invoked); ai → LLM with truthful fallback; default = ai
- [x] Server accepts `coachEngine` per attempt, responds with `coachSource` +
      `requestedEngine`; result header shows requested engine + actual source
      (`AI Coach` / `Rules Coach` / `Rules Coach — AI fallback`)
- [x] Groq default model fixed to `openai/gpt-oss-20b` (old default was retired);
      verified live: real `source=llm` analysis end-to-end (GROQ key from `.env`)
- [x] Diagnosed live: OpenRouter `nemotron:free` 404s and free-route hangs from
      here; both fail cleanly into Rules fallback with server-side reason logged
- [ ] MANUAL (user): select AI Coach, practice, confirm "AI Coach" badge; select
      Rules Coach, confirm "Rules Coach" and no LLM call; retry preserves engine
