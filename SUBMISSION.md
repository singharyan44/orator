# Orator — Hackathon Submission Pack (MVP)

## Links
- Live demo: https://learnwithorator.vercel.app
- Repo: https://github.com/singharyan44/orator

## Tagline
A real-time voice coach: speak, get specific feedback, retry, and see exactly
what improved — powered by AssemblyAI streaming transcription.

## Description (copy-paste)
Orator turns speaking practice into a measurable, adaptive loop. Pick a
prompt, speak, and get instant analysis grounded in real metrics — pace (WPM),
filler words, repeated words, and sentence structure — never generic praise.
Each attempt ends with one clear retry focus; speak again and the app compares
both attempts side by side. The system tracks your profile across sessions
and assigns the next exercise targeting YOUR weakest skill. Two more coaches
share the same engine: Debate Coach argues against you, attacking your
argument's weakest component, and Interview Coach runs adaptive interviews
with pressure follow-ups. Choose AI coaching (Groq/OpenRouter) with automatic
truthful fallback to a built-in deterministic coach. Test everything hands-free
with AI-written sample clips the app reads aloud for your mic.

## 60-second demo script
1. Open the live URL — point out the Speech Coach label + system status line.
2. Press Connect (live AssemblyAI transcription starts).
3. Start attempt → play Sample 1 → Finish → feedback with metrics + retry focus.
4. Try again → Sample 2 → Finish → comparison showing improvement.
5. Mention: AI/Rules coach engine selector with truthful fallback badges.

## Tech stack
Node.js + Express, AssemblyAI Universal-3.5 Pro Streaming (16 kHz PCM16),
Groq/OpenRouter LLMs, vanilla JS frontend, Vercel + GitHub.

## Known MVP limitations (honest)
- History/profile live in the browser (per-device, no accounts yet).
- AI coaching needs provider keys; otherwise the deterministic coach serves.
- Best on desktop Chrome/Edge; mobile works but is less polished.

## Market + business (for the judges)
- **Problem:** 75%+ of people fear public speaking; existing tools give
  generic tips ("be confident") with no practice loop and no measurement.
  Hiring pipelines lose strong candidates to weak interview delivery.
- **Who pays:** individual learners (freemium), career coaches & bootcamps
  (seat licenses), HR/talent teams (interview-prep screening at scale).
- **Model:** free practice + history; paid tiers for AI coaching depth,
  unlimited modes, team dashboards, API access.
- **Moat:** not the feedback — the adaptive loop (diagnose → targeted drill
  → measured retry) plus the personal profile that compounds per user.
- **Future:** more scenarios (negotiation, teaching, leadership), video-aware
  coaching (spiked), team/coach dashboards, mobile app.

## Cover image
`m0-voice-coach/public/cover.png` is a safe textless fallback (mic artwork,
16:9, valid). For the real submission cover, paste this into Nano Banana,
Gemini, or ChatGPT Images — then verify EVERY letter before uploading:

> Wide 16:9 banner, dark navy background (#0f172a). A glowing cyan
> microphone icon on the left. Large clean white sans-serif title "ORATOR".
> Beneath it, smaller cyan text "PRACTICE. DIAGNOSE. RETRY. IMPROVE." and
> gray text "SPEECH. DEBATE. INTERVIEW." Minimal, modern, high contrast,
> no people, no clutter. IMPORTANT: spell every word exactly as written.
