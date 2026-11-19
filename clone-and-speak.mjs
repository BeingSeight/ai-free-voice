// Voice clone + synthesize, one run.
// Cloning happens on HeyGen (OpenRouter has no clone endpoint — clones live in your
// HeyGen account and are used via OpenRouter BYOK). Synthesis uses OpenRouter, so
// the free-tier rate limit applies: 1 call, then stop. No retries on 429.
// Usage: HEYGEN_API_KEY=... node clone-and-speak.mjs
//   env: HEYGEN_API_KEY (required), OPENROUTER_API_KEY / OPENROUTER_MODEL / OPENROUTER_VOICE
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  existsSync(".env") ? readFileSync(".env", "utf8").split("\n").filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }) : []
);
const cfg = (k, d = "") => process.env[k] || env[k] || d;

const HEYGEN_KEY = cfg("HEYGEN_API_KEY");
const OR_KEY = cfg("OPENROUTER_API_KEY");
const OR_MODEL = cfg("OPENROUTER_MODEL", "heygen/heygen-voice-1-turbo:free");
const OR_VOICE = cfg("OPENROUTER_VOICE");
const AUDIO_URL = cfg("CLONE_AUDIO_URL"); // public HTTPS URL of the source audio (HeyGen clone API needs a URL)
const VOICE_NAME = cfg("CLONE_VOICE_NAME", "Sales Voice Clone");
const TEXT = cfg("SYNTH_TEXT", `Hey Murkdown, we came across this restaurant and spent a little time looking through what you're doing. You're operating in CITY CARE, and from what we could see, you've already built a solid presence there.

So let's consider an example: you are making 10,000 points monthly. Every customer that comes to you gives you, on average, 500 points.

As per our example, if 20 people are making us 10,000 points monthly, but the very next month only 5 of those customers return, whereas the rest, 20, are new. The problem lies here: if at least 10 of those customers would have returned every month, then our revenue would increase to 5,000 points plus our previous month's points.

And if in month 1 we started with 10,000 points, within 6 months we'll 2x our revenue points. Now imagine doing this for several months! This way we can do 4x revenue points every year!

If you're currently doing around 15,000 to 40,000 AED, even a relatively small improvement in repeat purchases could have a meaningful impact on your monthly revenue.

And in pretty simple words, our tool does this for you!

If you'd be interested, we'd be happy to jump on a quick call and show you exactly what we'd build.

Either way, appreciate you taking the time to watch — and wishing you and the team at Oliveto all the best.`);

if (!HEYGEN_KEY) { console.error("HEYGEN_API_KEY is required for cloning (OpenRouter cannot clone; it can only USE a HeyGen clone via BYOK)."); process.exit(1); }
if (!OR_KEY) { console.error("OPENROUTER_API_KEY missing in .env"); process.exit(1); }
if (!AUDIO_URL) { console.error("CLONE_AUDIO_URL missing — HeyGen clone API needs a PUBLIC HTTPS URL to your source audio (upload the mp3 somewhere public first)."); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

// 1) Clone on HeyGen
log("Cloning voice on HeyGen...");
const cloneRes = await fetch("https://api.heygen.com/v3/voices/clone", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": HEYGEN_KEY },
  body: JSON.stringify({ audio: { type: "url", url: AUDIO_URL }, voice_name: VOICE_NAME, language: "en", remove_background_noise: true }),
});
const cloneJson = await cloneRes.json().catch(() => ({}));
if (!cloneRes.ok) { console.error("Clone failed:", cloneRes.status, JSON.stringify(cloneJson)); process.exit(1); }
const cloneId = cloneJson.data?.voice_clone_id;
log("Clone started, id:", cloneId);

// 2) Poll until complete (max ~5 min, 10 poll calls, 30s apart — HeyGen side, not OpenRouter quota)
let voiceId = null;
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 30000));
  const r = await fetch("https://api.heygen.com/v3/voices/", { headers: { "x-api-key": HEYGEN_KEY } });
  const j = await r.json().catch(() => ({}));
  const found = (j.data || j.voices || []).find(v => v.voice_clone_id === cloneId || v.id === cloneId || v.voice_id === cloneId);
  log(`Poll ${i + 1}:`, found ? JSON.stringify(found).slice(0, 300) : "not found yet");
  if (found && (found.status === "complete" || found.status === "ready" || found.voice_id)) { voiceId = found.voice_id || found.id; break; }
  if (found && found.status === "failed") { console.error("Clone failed on HeyGen side."); process.exit(1); }
}
if (!voiceId) { console.error("Clone did not complete in time. Check HeyGen dashboard; then set OPENROUTER_VOICE to the clone id."); process.exit(1); }
log("Clone complete. voice_id =", voiceId);
writeFileSync("cloned-voice-id.txt", voiceId);

// 3) Synthesize ONCE via OpenRouter (counts against free daily quota — no retry loop)
log("Synthesizing via OpenRouter, model:", OR_MODEL, "voice:", voiceId);
const tts = await fetch("https://openrouter.ai/api/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OR_KEY}`, "HTTP-Referer": "http://localhost:3000", "X-Title": "Text to Voice" },
  body: JSON.stringify({ model: OR_MODEL, input: TEXT, voice: voiceId, speed: 1, response_format: "pcm" }), // HeyGen on OR = PCM only
});
if (tts.status === 429) { console.error("OpenRouter 429 rate limited. Stopping (no retry) to protect quota. Retry-After:", tts.headers.get("retry-after")); process.exit(2); }
if (!tts.ok) { console.error("TTS failed:", tts.status, (await tts.text()).slice(0, 500)); process.exit(1); }
const ct = tts.headers.get("content-type") || "";
let pcm;
if (ct.includes("application/json")) {
  const j = await tts.json();
  const url = j.audio_url || j.url || j.data?.audio_url;
  if (!url) { console.error("No audio URL in response:", JSON.stringify(j).slice(0, 500)); process.exit(1); }
  pcm = Buffer.from(await (await fetch(url)).arrayBuffer());
} else {
  pcm = Buffer.from(await tts.arrayBuffer());
}
function pcmToWav(pcm, sr = 44100) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
writeFileSync("output.wav", pcmToWav(pcm));
log(`Done. Saved output.wav (${pcm.length} bytes PCM).`);
