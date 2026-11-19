# Text to Voice — HeyGen Voice Turbo via OpenRouter (free)

Very simple app: paste text → Generate → Play / Download MP3.
One fixed voice, configured by the admin only. The team member only types a script.

## Research findings (OpenRouter, verified)

**Model (openrouter.ai/heygen):**
- `heygen/heygen-voice-1-turbo` — HeyGen Voice Turbo, $4/M characters, 44.1kHz, 39 languages, **max 5,000 chars/request**, 10 default voices.
- `heygen/heygen-voice-1-turbo:free` — **free variant** ($0), same voice. ⚠️ Listed as **going away Nov 30, 2026** — if it disappears, switch `OPENROUTER_MODEL` to the paid id.
- Voice cloning: the default 10 voices work out of the box. To use *your own cloned* voice, bring your own HeyGen key (set `HEYGEN_API_KEY` in `.env`) — OpenRouter docs state clones require your HeyGen account key.

**API (OpenRouter TTS):**
```
POST https://openrouter.ai/api/v1/audio/speech
Authorization: Bearer <OPENROUTER_API_KEY>
{ "model": "heygen/heygen-voice-1-turbo:free", "input": "<text>", "voice": "<voice_id>", "speed": 1, "response_format": "mp3" }
→ raw MP3 byte-stream
```
Check remaining quota anytime: `GET https://openrouter.ai/api/v1/key` (`limit_remaining`, `usage`, `free_model_daily_requests`).

**Rate limits — answer to your question:**
From OpenRouter docs (openrouter.ai/docs/limits): *"Making additional accounts or API keys will not affect your rate limits, as we govern capacity globally."*
- Free variants (`:free`): **shared across ALL free models on the account** — ~20 req/min and **50 req/day if you've purchased < $10 credits, 1000 req/day if ≥ $10**. Making a 2nd key or using a 2nd free model does **NOT** give you a 2nd quota.
- OpenRouter also has **per-model** caps, so a different model doesn't bypass them either.
- → This app enforces ONE shared limiter (10/min, 50/day, 3s gap) before accepting input, and honors `Retry-After` on 429 so you don't get banned.

## Setup (admin only, once)
1. Get an OpenRouter key at openrouter.ai/keys (buy ≥$10 credit if you need >50/day).
2. Pick your ONE voice id from the model's voice list (or clone on HeyGen + set `HEYGEN_API_KEY` for BYO-key mode).
3. `cp .env.example .env` → set `OPENROUTER_API_KEY`, `OPENROUTER_VOICE` (optional), done.
4. `node server.js` → open http://localhost:3000

## Rate-limit protection (built in)
- Min gap 3s, max 10/min, max 50/day (env-tunable via `RATE_*`).
- Only 1 generation at a time; button disables with countdown.
- On upstream 429, backs off using `Retry-After`.
- Daily counter is in-memory (resets on restart) — fine for a small team.

## Team member workflow
Type/paste script (≤5,000 chars) → Generate voice → Listen → Download MP3. No settings visible.
