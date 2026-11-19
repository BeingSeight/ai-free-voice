// Very simple Text-to-Voice — HeyGen Voice Turbo via OpenRouter (free variant).
// Settings are configured ONLY here via environment variables / .env — never in the UI.
// Run:  node server.js   then open http://localhost:3000
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

// ---------- config (server-side only, never sent to browser) ----------
const env = Object.fromEntries(
  existsSync(".env") ? readFileSync(".env", "utf8").split("\n").filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }) : []
);
const cfg = (k, d = "") => process.env[k] || env[k] || d;

const CONFIG = {
  port: Number(cfg("PORT", "3000")),
  openRouterApiKey: cfg("OPENROUTER_API_KEY"),      // from openrouter.ai/keys (server-side only)
  openRouterBaseUrl: cfg("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  // Default = FREE variant. Use heygen/heygen-voice-1-turbo (paid, $4/M chars) if free goes away.
  model: cfg("OPENROUTER_MODEL", "heygen/heygen-voice-1-turbo:free"),
  voice: cfg("OPENROUTER_VOICE", ""),               // ONE voice id chosen by you (see README)
  heygenApiKey: cfg("HEYGEN_API_KEY"),              // optional: BYO HeyGen key to use your cloned voice
  speed: Number(cfg("SPEED", "1")),
  maxChars: Number(cfg("MAX_CHARS", "5000")),       // HeyGen Turbo limit: 5,000 chars/request
  // ---- rate limit (conservative — OpenRouter free tier is account-global, see README) ----
  minIntervalMs: Number(cfg("RATE_MIN_INTERVAL_MS", "3000")), // min gap between ANY upstream calls
  maxPerMinute: Number(cfg("RATE_MAX_PER_MINUTE", "10")),
  maxPerDay: Number(cfg("RATE_MAX_PER_DAY", "50")),  // free tier ~50/day if < $10 purchased; 1000/day if >= $10
};


// ---------- account-level rate limiter ----------
// OpenRouter: "Making additional accounts or API keys will not affect your rate
// limits, as we govern capacity globally." Free-variant caps are per ACCOUNT and
// shared across ALL free models — so 2 keys / 2 models on one account do NOT
// double your quota. Hence ONE shared limiter for every upstream call.
// Also, OpenRouter has per-model caps, so using another model does not bypass them.
class Limiter {
  constructor() { this.timestamps = []; this.blockedUntil = 0; this.lastCall = 0; this.inFlight = false; }
  status() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 86400000);
    const perMin = this.timestamps.filter(t => now - t < 60000).length;
    const waitMs = Math.max(0, this.blockedUntil - now, CONFIG.minIntervalMs - (now - this.lastCall));
    const reason = now < this.blockedUntil ? "blocked (429 backoff)"
      : this.timestamps.length >= CONFIG.maxPerDay ? "daily limit reached"
      : perMin >= CONFIG.maxPerMinute ? "minute limit reached"
      : waitMs > 0 ? "cooldown" : null;
    return { ok: !reason, reason, waitSeconds: Math.ceil(waitMs / 1000), usedToday: this.timestamps.length, maxPerDay: CONFIG.maxPerDay, perMinute: perMin, maxPerMinute: CONFIG.maxPerMinute };
  }
  async acquire() {
    const s = this.status();
    if (!s.ok) throw Object.assign(new Error(`Rate limited: ${s.reason}. Try again in ${s.waitSeconds}s.`), { status: 429, retryAfter: s.waitSeconds });
    if (this.inFlight) throw Object.assign(new Error("Another generation is already running."), { status: 429, retryAfter: 3 });
    this.inFlight = true; this.lastCall = Date.now();
  }
  release() { this.inFlight = false; }
  record() { this.timestamps.push(Date.now()); }
  penalize(sec) { this.blockedUntil = Date.now() + (sec || 60) * 1000; }
}
const limiter = new Limiter();
let lastAudio = null; // last generated audio (binary MP3 buffer), served at /api/last-audio

// ---------- upstream: OpenRouter TTS (HeyGen Voice Turbo) ----------
// OpenRouter TTS: POST {base}/audio/speech
// Body: { model, input, voice, speed, response_format }
// Response: raw audio byte-stream (mp3 when response_format="mp3")
async function callHeyGenTTS(text) {
  const r = await fetch("https://api.heygen.com/v3/models/audio/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CONFIG.heygenApiKey },
    body: JSON.stringify({ model: "heygen-voice-1-turbo-free", text, voice_id: "330290724a1b470fb63153f34d4c0183" }),
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after")) || 10;
    limiter.penalize(retry);
    throw Object.assign(new Error(`HeyGen rate limit (429) — retry in ${retry}s`), { status: 429, retryAfter: retry });
  }
  if (!r.ok) {
    const body = (await r.text()).slice(0, 400);
    let msg = body; try { msg = JSON.parse(body)?.error?.message || body; } catch {}
    throw Object.assign(new Error(`HeyGen error ${r.status}: ${msg}`), { status: r.status });
  }
  const j = await r.json();
  const url = j.data?.audio_url; const dur = j.data?.duration;
  if (!url) throw new Error("No audio_url in HeyGen response");
  return { audioUrl: url, duration: dur };
}

// ---------- PCM -> WAV (OpenRouter/HeyGen returns raw 44.1kHz mono PCM) ----------
function pcmToWav(pcm, sampleRate = 44100) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// ---------- http server ----------
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
http.createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const pathname = new URL(req.url, "http://localhost").pathname; // ignore ?t= cache-buster
  try {
    if (pathname === "/") return send(200, html, "text/html");
    if (pathname === "/api/status") return send(200, { ready: !!CONFIG.heygenApiKey, provider: "heygen", model: "heygen-voice-1-turbo-free", maxChars: CONFIG.maxChars, rate: limiter.status() });
    // Play in browser: inline (attachment makes some browsers refuse to play)
    if (pathname === "/api/last-audio" && lastAudio) { res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": lastAudio.length, "Cache-Control": "no-store" }); return res.end(lastAudio); }
    // Download: attachment
    if (pathname === "/api/download" && lastAudio) { res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": lastAudio.length, "Content-Disposition": 'attachment; filename="voice.wav"', "Cache-Control": "no-store" }); return res.end(lastAudio); }
    if (req.url === "/api/generate" && req.method === "POST") {
      const text = (JSON.parse(await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); })).text || "").trim();
      if (!text) return send(400, { error: "Text is empty." });
      if (text.length > CONFIG.maxChars) return send(400, { error: `Too long — max ${CONFIG.maxChars} characters.` });
      await limiter.acquire();
      try { const r = await callHeyGenTTS(text); limiter.record(); return send(200, r); }
      finally { limiter.release(); }
    }
    send(404, { error: "Not found" });
  } catch (e) { send(e.status || 500, { error: e.message, retryAfter: e.retryAfter }); }
}).listen(CONFIG.port, () => console.log(`Voice app → http://localhost:${CONFIG.port}  (model=${CONFIG.model})`));
