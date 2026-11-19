// Vercel serverless adapter — same logic as server.js, one function for all routes.
// NOTE: serverless = stateless, so the in-memory limiter is per-instance, not global.
// The real hard cap is OpenRouter's account-level quota (enforced upstream, 429 handled).
import { readFileSync } from "node:fs";

const cfg = (k, d = "") => process.env[k] || d;
const CONFIG = {
  openRouterApiKey: cfg("OPENROUTER_API_KEY"),
  openRouterBaseUrl: cfg("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  model: cfg("OPENROUTER_MODEL", "heygen/heygen-voice-1-turbo:free"),
  voice: cfg("OPENROUTER_VOICE", ""),
  heygenApiKey: cfg("HEYGEN_API_KEY"),
  speed: Number(cfg("SPEED", "1")),
  maxChars: Number(cfg("MAX_CHARS", "5000")),
  minIntervalMs: Number(cfg("RATE_MIN_INTERVAL_MS", "3000")),
  maxPerMinute: Number(cfg("RATE_MAX_PER_MINUTE", "10")),
  maxPerDay: Number(cfg("RATE_MAX_PER_DAY", "50")),
};

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

function pcmToWav(pcm, sampleRate = 44100) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export default async function handler(req, res) {
  const send = (code, body, type = "application/json") => {
    res.statusCode = code; res.setHeader("Content-Type", type);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    if (pathname === "/") return send(200, readFileSync(process.cwd() + "/index.html", "utf8"), "text/html");
    if (pathname === "/api/status")
      return send(200, { ready: !!CONFIG.openRouterApiKey, provider: "openrouter", model: CONFIG.model, maxChars: CONFIG.maxChars, rate: limiter.status() });

    if (pathname === "/api/generate" && req.method === "POST") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const text = (JSON.parse(Buffer.concat(chunks).toString() || "{}").text || "").trim();
      if (!text) return send(400, { error: "Text is empty." });
      if (text.length > CONFIG.maxChars) return send(400, { error: `Too long — max ${CONFIG.maxChars} characters.` });
      await limiter.acquire();
      try {
        const headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CONFIG.openRouterApiKey}`,
          "HTTP-Referer": "https://text-to-voice.vercel.app",
          "X-Title": "Text to Voice",
        };
        if (CONFIG.heygenApiKey) headers["X-HeyGen-Api-Key"] = CONFIG.heygenApiKey;
        const r = await fetch(`${CONFIG.openRouterBaseUrl}/audio/speech`, {
          method: "POST", headers,
          body: JSON.stringify({ model: CONFIG.model, input: text, voice: CONFIG.voice || undefined, speed: CONFIG.speed, response_format: "pcm" }),
        });
        if (r.status === 429) {
          const retry = Number(r.headers.get("retry-after")) || 60;
          limiter.penalize(retry);
          return send(429, { error: `OpenRouter rate limit (429) — retry in ${retry}s`, retryAfter: retry });
        }
        if (!r.ok) {
          const body = (await r.text()).slice(0, 400);
          let msg = body; try { msg = JSON.parse(body)?.error?.message || body; } catch {}
          return send(r.status, { error: `OpenRouter error ${r.status}: ${msg}` });
        }
        const ct = r.headers.get("content-type") || "";
        let pcm;
        if (ct.includes("application/json")) {
          const j = await r.json();
          const url = j.audio_url || j.url || j.data?.audio_url;
          if (url) { limiter.record(); return send(200, { audioUrl: url }); }
          if (j.audio) pcm = Buffer.from(j.audio, "base64");
          else return send(500, { error: "Unexpected JSON response from TTS provider (no audio found)" });
        } else pcm = Buffer.from(await r.arrayBuffer());
        const wav = pcmToWav(pcm);
        limiter.record();
        res.statusCode = 200; res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Length", wav.length); res.setHeader("Cache-Control", "no-store");
        return res.end(wav);
      } finally { limiter.release(); }
    }
    send(404, { error: "Not found" });
  } catch (e) { send(e.status || 500, { error: e.message, retryAfter: e.retryAfter }); }
}
