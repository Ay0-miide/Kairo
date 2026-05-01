// KAIRO v2 — Node.js Backend Server
// Express + WebSocket. Handles:
//   • Deepgram live STT
//   • Scripture detection: reference parser → verbatim phrase → fingerprint coverage
//   • ProPresenter REST API integration
//   • Settings persistence
//
// Detection speed improvements:
//   • Detection is ready seconds after startup — no ML model to load.
//   • Reference detection runs on interim transcripts (fires ~1s before final),
//     so "1 John 1:10" appears in < 2s end-to-end.
'use strict';

const path       = require('path');
const fs         = require('fs');
const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const { WebSocketServer } = require('ws');
const { Worker } = require('worker_threads');
const axios      = require('axios');
const OBSWebSocket = require('obs-websocket-js/json').default;

const { parseSpokenReference, parseAllSpokenReferences, resolvePartialReference, detectBookMentions, referenceContext, SINGLE_WORD_BOOKS } = require('./reference_parser');

// ── Config ────────────────────────────────────────────────────────────────
const PORT = 7777;

// When running inside the Tauri bundle, KAIRO_DB_DIR points to the resource
// directory where map.json and kjv.json are copied at build time.
// In dev, fall back to the project-root databases folder.
const DATA_DIR = process.env.KAIRO_DB_DIR
  || path.join(__dirname, '..', 'databases', 'logos');

// ── Sentence Buffer ───────────────────────────────────────────────────────
// Accumulates is_final Deepgram fragments into complete sentences before
// running expensive verbatim/fingerprint detection.
// Direct reference parsing (instant) still fires on every fragment.
// Flushes on: sentence-ending punctuation, speech_final, or 4s timeout.
class SentenceBuffer {
  constructor(timeoutMs = 4000) {
    this._buf        = '';
    this._lastAppend = 0;
    this._timeoutMs  = timeoutMs;
  }

  // Append a final fragment. Returns flushed sentence if boundary detected, else null.
  append(text) {
    if (!text) return null;
    this._buf        = this._buf ? this._buf + ' ' + text : text;
    this._lastAppend = Date.now();
    const t = this._buf.trimEnd();
    if (t.endsWith('.') || t.endsWith('!') || t.endsWith('?')) return this._flush();
    return null;
  }

  // Check if the buffer has timed out (call periodically).
  checkTimeout() {
    if (!this._buf || !this._lastAppend) return null;
    if (Date.now() - this._lastAppend >= this._timeoutMs) return this._flush();
    return null;
  }

  // Force-flush on speech_final.
  forceFlush() {
    if (!this._buf) return null;
    return this._flush();
  }

  get content() { return this._buf; }
  get hasContent() { return !!this._buf; }

  _flush() {
    const text = this._buf.trim();
    this._buf        = '';
    this._lastAppend = 0;
    return text || null;
  }
}

// ── Cached regex patterns (hot-path) ─────────────────────────────────────
const RE_NONALPHA   = /[^a-z\s]/g;
const RE_WHITESPACE = /\s+/g;
const RE_SPACES     = /\s+/;

// ── Settings ──────────────────────────────────────────────────────────────
// In production (Tauri bundle) the resource dir is read-only on macOS/Windows.
// lib.rs passes KAIRO_APP_DATA_DIR pointing to the user-writable app-data folder.
// In dev, fall back to the repo databases/ directory so existing settings persist.
const SETTINGS_PATH = process.env.KAIRO_APP_DATA_DIR
  ? path.join(process.env.KAIRO_APP_DATA_DIR, 'settings.json')
  : path.join(__dirname, '..', 'databases', 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}
let settings = loadSettings();

// ── OBS WebSocket ─────────────────────────────────────────────────────────
let obsClient    = null;
let obsConnected = false;

async function connectOBS() {
  if (obsClient) { try { await obsClient.disconnect(); } catch {} obsClient = null; }
  obsConnected = false;
  const s = loadSettings();
  if (!s.obsEnabled) return;
  obsClient = new OBSWebSocket();
  obsClient.on('ConnectionClosed', () => { obsConnected = false; console.log('[OBS] Disconnected'); });
  obsClient.on('ConnectionError',  () => { obsConnected = false; });
  try {
    await obsClient.connect(s.obsUrl || 'ws://localhost:4455', s.obsPassword || '');
    obsConnected = true;
    console.log('[OBS] Connected to', s.obsUrl || 'ws://localhost:4455');
  } catch (e) {
    obsConnected = false;
    obsClient = null;
    console.log('[OBS] Connection failed:', e.message);
  }
}

async function sendToOBS(verse) {
  if (!obsConnected || !obsClient) return false;
  const s          = loadSettings();
  const sourceName = s.obsTextSource || 'Scripture';
  const t          = s.translation || 'KJV';
  const text       = verse.text + '\n' + verse.reference + ' (' + t + ')';
  try {
    await obsClient.call('SetInputSettings', {
      inputName:     sourceName,
      inputSettings: { text },
    });
    return true;
  } catch (e) {
    console.warn('[OBS] Send failed:', e.message);
    if (e.code === 1006 || e.message?.includes('closed')) obsConnected = false;
    return false;
  }
}

async function testOBSConnection(url, password) {
  const client = new OBSWebSocket();
  try {
    await client.connect(url || 'ws://localhost:4455', password || '');
    const { obsVersion } = await client.call('GetVersion');
    await client.disconnect();
    return { success: true, version: obsVersion };
  } catch (e) {
    try { await client.disconnect(); } catch {}
    return { success: false, error: e.message };
  }
}

// Connect OBS on startup if enabled
setTimeout(() => {
  if (loadSettings().obsEnabled) connectOBS().catch(err => console.warn('[OBS] Initial connect failed:', err.message));
}, 2000);

// ── Detection Worker ──────────────────────────────────────────────────────
let detectionWorker  = null;
let workerBasicReady = false;   // all three layers ready after init
const pendingCallbacks = new Map();
let workerMsgId = 0;

function spawnDetectionWorker() {
  detectionWorker = new Worker(path.join(__dirname, 'detection_worker.js'), {
    workerData: { dataDir: DATA_DIR },
  });

  detectionWorker.on('message', (msg) => {
    if (msg.type === 'ready') {
      workerBasicReady = true;
      broadcast({ type: 'worker-ready' });
      console.log('[Server] Detection worker ready (reference + verbatim + fingerprint).');
      return;
    }
    if (msg.type === 'initError') {
      console.error('[Server] Worker init error:', msg.error);
      broadcast({ type: 'worker-error', error: msg.error });
      return;
    }
    const cb = pendingCallbacks.get(msg.id);
    if (cb) {
      clearTimeout(cb.timeout);
      pendingCallbacks.delete(msg.id);
      cb.resolve(msg);
    }
  });

  detectionWorker.on('error', (err) => {
    console.error('[Server] Worker error:', err.message);
    for (const [id, cb] of pendingCallbacks) {
      clearTimeout(cb.timeout);
      cb.reject(err);
    }
    pendingCallbacks.clear();
    broadcast({ type: 'worker-error', error: err.message });
  });

  // If the worker exits for any reason, detection silently stops unless we
  // flip the ready flag and respawn. Without this, every workerCall rejects
  // after its timeout and references are lost with only a console warn.
  detectionWorker.on('exit', (code) => {
    console.warn(`[Server] Detection worker exited (code=${code}) — respawning`);
    workerBasicReady = false;
    for (const [id, cb] of pendingCallbacks) {
      clearTimeout(cb.timeout);
      cb.reject(new Error('Worker exited'));
    }
    pendingCallbacks.clear();
    detectionWorker = null;
    broadcast({ type: 'worker-error', error: `exit(${code})` });
    setTimeout(spawnDetectionWorker, 500);
  });
}

function workerCall(type, payload, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!detectionWorker) return reject(new Error('Worker not started'));
    const id = ++workerMsgId;
    const timeout = setTimeout(() => {
      pendingCallbacks.delete(id);
      console.warn(`[Server] Worker timeout (${type}) after ${timeoutMs}ms`);
      broadcast({ type: 'worker-timeout', op: type, timeoutMs });
      reject(new Error(`Worker timeout: ${type}`));
    }, timeoutMs);
    pendingCallbacks.set(id, { resolve, reject, timeout });
    detectionWorker.postMessage({ type, id, ...payload });
  });
}

// ── Express ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
// Cap body size — sermon transcripts comfortably fit, but prevents memory
// exhaustion from a malicious or runaway client posting megabytes of garbage.
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'src')));

// ── WebSocket ─────────────────────────────────────────────────────────────
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send current worker status on connect
  ws.send(JSON.stringify({ type: 'worker-status', ready: workerBasicReady }));

  // Forward binary audio frames to whichever engine is active.
  // - Deepgram: streamed straight to the WS connection (Deepgram does endpointing)
  // - Vosk:     fed to the local recognizer; result() / partialResult() drive detection
  // Either way we keep a short audio ring buffer for the REST fallback path.
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (deepgramConnection) {
      try { deepgramConnection.send(chunk); } catch {}
    } else if (voskActive) {
      feedVoskAudio(chunk);
    }
    audioRingBuffer.push({ data: chunk, time: Date.now() });
    audioRingBytes += chunk.length;
    while (audioRingBytes > AUDIO_RING_MAX_BYTES && audioRingBuffer.length) {
      audioRingBytes -= audioRingBuffer.shift().data.length;
    }
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// ── Deepgram state ────────────────────────────────────────────────────────
let deepgramConnection    = null;
let connectionState       = 'disconnected';
let deepgramUserStopped   = false;   // true when user explicitly stops — suppresses auto-reconnect
let deepgramLastConfig    = {};      // last config passed to startDeepgram — used for reconnect
let deepgramKeepAliveTimer  = null;  // 8-second ping to prevent silent connection drop
let deepgramSilenceWatchdog = null;  // 30-second watchdog — reconnects if no transcript received
let deepgramLastTranscriptAt = 0;    // timestamp of last received transcript segment

// ── Vosk (offline STT) state ──────────────────────────────────────────────
// Loaded lazily on first use so we don't pay the ~80MB RAM cost when the
// user is on Deepgram. Model is reused across sessions; recognizer is per-session.
let voskLib          = null;        // require('vosk-koffi'), loaded once
let voskModel        = null;        // Vosk.Model instance — heavy, kept alive
let voskRecognizer   = null;        // per-listening-session recognizer
let voskActive       = false;       // true when Vosk path is the active engine
let voskLastPartial  = '';          // last partial we broadcast — dedupe noise
let voskPartialFlushTimer = null;   // throttles partials so we don't flood detection
const VOSK_SAMPLE_RATE = 16000;
const VOSK_PARTIAL_FLUSH_MS = 220;  // emit partials at most ~4×/s
const VOSK_MODEL_PATH = path.join(__dirname, 'models', 'vosk-en');
let transcriptBuffer    = [];
let lastFingerprintSearch    = 0;
const FINGERPRINT_INTERVAL_MS = 1000;   // don't run fingerprint search more than once per 1s
let hasNewTranscript    = false;
let inBibleMode         = false;
let bibleModeClearTimer = null;

// Deduplication
let lastSentRef  = null;
let lastSentTime = 0;
const SEND_DEDUP_MS = 8000;      // Prevent same verse re-sending within 8 s

let lastDetectedRef  = null;
let lastDetectedTime = 0;
const DETECT_DEDUP_MS = 45000;   // Same verse won't flood SENT list for 45 s

// ── Ensemble scoring ───────────────────────────────────────────────────────
// When verbatim + fingerprint agree on the same verse within ENSEMBLE_WINDOW_MS,
// boost the combined score and re-broadcast. Direct detection always wins.
const ENSEMBLE_WINDOW_MS = 6000;
const ENSEMBLE_BOOST     = 0.08;   // add 8 points to the score when two paths agree

// Map<verseKey, { score, method, verses, time }>
const ensembleCache = new Map();

// Same-book close-succession: if a new verse from the same book arrives within
// this window, assume the preacher is correcting/continuing — always let it through.
let lastSentBook = null;
let lastSentBookTime = 0;
const SAME_BOOK_WINDOW_MS = 60000;

// Minimum confidence score to auto-route a detection to the live viewer/SENT.
// Anything below this is demoted to suggestions regardless of fingerprint confidence level.
const VIEWER_MIN_SCORE = 0.80;

// Minimum score for a detection to appear in the suggestions panel at all.
// Keeps low-confidence random verses (e.g. Matthew 17:21 at 42%) off the screen entirely.
const SUGGESTION_MIN_SCORE = 0.75;

// Track what we already detected from interim so we skip on final
let interimDetectedRef  = null;
let interimDetectedTime = 0;

// Throttle verbatim search on interim — don't hammer the worker on every word
let lastInterimVerbatim = 0;
const INTERIM_VERBATIM_MS = 500;  // run at most once per 500ms on interim

// Sentence-level accumulator — verbatim/fingerprint run on complete sentences
let sentenceBuffer = new SentenceBuffer(4000);

// Suppress fingerprint search from routing to viewer for N ms after a direct reference
let lastDirectRefTime = 0;
const DIRECT_REF_SUPPRESS_MS = 12000;

// Auto-correction window: if a direct ref was sent and within this window a
// verbatim match (≥ 0.92 similarity) points at a *different* verse, we assume
// the preacher mis-cited the reference and then read the correct verse
// verbatim — replace on-air instead of queueing alongside.
// Gated by settings.autoCorrect (default on) so the operator can disable.
let lastDirectSentVerse = null;    // full verse object of the most recent direct-ref send
let lastDirectSentTime  = 0;
const CORRECTION_WINDOW_MS = 15000;
const CORRECTION_MIN_SIMILARITY = 0.92;

// ── Audio ring buffer (REST fallback on WS drop) ──────────────────────────
// Keeps last 25s of raw PCM so we can submit to Deepgram REST if the
// WebSocket drops mid-sermon. 16kHz × 2 bytes × 25s = 800 000 bytes.
const AUDIO_RING_MAX_BYTES = 16000 * 2 * 25;
let audioRingBuffer = [];   // [{ data: Buffer, time: number }, ...]
let audioRingBytes  = 0;

// ── Reading mode ───────────────────────────────────────────────────────────
// When the pastor reads scripture verbatim for an extended stretch, detection
// thresholds tighten and the range auto-advance becomes more sensitive.
// Exit when the hit rate drops (conversational speech returns).
const READING_MODE_WINDOW_MS   = 30000;  // evaluation window
const READING_MODE_HIT_THRESH  = 3;      // hits in window to enter reading mode

let readingModeActive    = false;
let readingModeBook      = null;
let readingModeChapter   = null;
let readingModeHits      = 0;
let lastReadingModeReset = 0;

function trackReadingModeHit(verse, similarity) {
  if (similarity < 0.92) return;
  readingModeHits++;
  const now = Date.now();
  if (now - lastReadingModeReset < READING_MODE_WINDOW_MS) return;
  // Window expired — evaluate and reset
  lastReadingModeReset = now;
  const wasActive      = readingModeActive;
  readingModeActive    = readingModeHits >= READING_MODE_HIT_THRESH;
  if (readingModeActive) {
    readingModeBook    = verse?.book    || readingModeBook;
    readingModeChapter = verse?.chapter || readingModeChapter;
  }
  if (wasActive !== readingModeActive) {
    console.log(`[Reading] Mode ${readingModeActive ? 'ON' : 'OFF'}${readingModeActive ? ` — ${readingModeBook} ${readingModeChapter}` : ''}`);
    broadcast({ type: 'reading-mode', active: readingModeActive, book: readingModeBook, chapter: readingModeChapter });
  }
  readingModeHits = 0;
}

function resetReadingMode() {
  readingModeActive    = false;
  readingModeBook      = null;
  readingModeChapter   = null;
  readingModeHits      = 0;
  lastReadingModeReset = 0;
}

// ── Deepgram REST fallback ─────────────────────────────────────────────────
// Submits buffered audio to Deepgram REST API when the WebSocket drops
// mid-sermon. Catches the gap that would otherwise be silently lost.
async function submitDeepgramRestFallback() {
  if (!audioRingBuffer.length) return;
  const key = settings.deepgramApiKey || loadSettings().deepgramApiKey;
  if (!key) return;

  // Only submit audio captured in the last 20s (avoid re-processing old audio)
  const cutoff     = Date.now() - 20000;
  const recentAudio = audioRingBuffer.filter(c => c.time >= cutoff);
  if (!recentAudio.length) return;

  console.log(`[Deepgram] REST fallback — submitting ${recentAudio.length} buffered chunks…`);
  const combined = Buffer.concat(recentAudio.map(c => c.data));

  try {
    const response = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=en-US&smart_format=true&punctuate=true',
      combined,
      {
        headers: {
          'Authorization': `Token ${key}`,
          'Content-Type': 'audio/raw;encoding=linear16;sample_rate=16000;channels=1',
        },
        timeout: 15000,
      }
    );
    const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    if (transcript.trim()) {
      console.log('[Deepgram] REST fallback transcript:', transcript.slice(0, 100));
      broadcast({ type: 'transcript', text: transcript, isFinal: true, confidence: 0.9, source: 'rest-fallback' });
      // Run full detection pipeline on the recovered transcript
      await processForReferences(transcript, true);
      if (workerBasicReady) {
        await Promise.all([processVerbatim(transcript), runFingerprintSearch(transcript, true)]);
      }
    }
  } catch (err) {
    console.warn('[Deepgram] REST fallback failed:', err.message);
  }
}

// ── Range Queue ───────────────────────────────────────────────────────────
// When a verse range is detected (e.g. Matt 1:10-15), verse 1 auto-sends
// immediately. The remaining verses are queued.
//
// Auto-advance: on every transcript, if a range is active we run a targeted
// verbatim check specifically against the NEXT queued verse. If the preacher's
// speech matches it (similarity ≥ 0.70), it auto-sends — no operator click
// needed. The preacher's reading pace drives the navigation naturally.
//
// Manual advance: operator can still click "Next →" at any time (e.g. if the
// preacher skips a verse or the mic misses a line).
let rangeQueue        = [];    // remaining verses not yet displayed
let rangeQueueTotal   = 0;    // total verses in this range (for UI display)
let rangeAllVerses    = [];   // all verses in range (sent + queued) — for UI display
let rangeCurrentVerse = null; // the verse currently on the live screen
let rangeAdvancing      = false;
let rangeLastAdvanceAt  = 0;   // timestamp of last advance — prevents rapid re-fires
let rangeVerseStartTime = 0;   // when the current range verse was loaded — used for timing advance
const RANGE_ADVANCE_COOLDOWN_MS = 1200;  // min gap between advances (fast readers)

// ── Last-2-words end-of-verse detection ──────────────────────────────────────
// Much more reliable than similarity search: we know exactly which words end
// the current verse, so we just watch for them in the rolling transcript.
// E.g. "prayer and fasting" → last 2 meaningful words are "prayer fasting".
// When those appear, the preacher has finished the verse → advance.
const SKIP_WORDS = new Set(['a','an','the','and','but','or','in','of','to','is','it','be','he',
  'she','ye','thy','thee','thou','unto','his','her','its','my','our','your','their',
  'was','are','were','that','this','from','with','for','not','i','we','by','at']);

function getLastMeaningfulWords(text, n = 2) {
  const cleaned = (text || '')
    .replace(/\{[^}]*\}/g, '')   // strip {art} {is} {thirsty: Heb. weary} annotations
    .replace(/\[[^\]]*\]/g, ''); // strip [A Psalm of David…] headings — not spoken
  const words = cleaned
    .toLowerCase()
    .replace(RE_NONALPHA, '')
    .split(RE_SPACES)
    .filter(w => w.length >= 3 && !SKIP_WORDS.has(w));
  return words.slice(-n).join(' ');
}

function setRangeQueue(verses) {
  rangeAllVerses      = verses.slice();
  rangeCurrentVerse   = verses[0] || null;
  rangeQueue          = verses.slice(1);
  rangeQueueTotal     = verses.length;
  rangeAdvancing      = false;
  rangeVerseStartTime = Date.now();
  broadcastRangeState();
  // Send all verses to UI so the full range is visible in history
  broadcast({ type: 'range-verses', verses: rangeAllVerses, activeRef: rangeCurrentVerse?.reference || null });
}

async function advanceRangeQueue() {
  if (!rangeQueue.length) return null;
  const next = rangeQueue.shift();
  rangeCurrentVerse   = next;
  rangeVerseStartTime = Date.now();
  broadcastRangeState();
  await sendToOutputs(next);
  broadcast({ type: 'detection', verses: [next], method: 'direct', topScore: 1.0, target: 'viewer', timestamp: Date.now() });
  // Update active reference in UI
  broadcast({ type: 'range-active', activeRef: next.reference });
  return next;
}

function clearRangeQueue() {
  rangeQueue        = [];
  rangeQueueTotal   = 0;
  rangeAllVerses    = [];
  rangeCurrentVerse = null;
  rangeAdvancing    = false;
  broadcastRangeState();
}

function broadcastRangeState() {
  broadcast({
    type:      'range-state',
    remaining: rangeQueue.length,
    total:     rangeQueueTotal,
    next:      rangeQueue[0] || null,
  });
}

// ── Reading-pace estimator ────────────────────────────────────────────────
// Looks at the last 15 seconds of finalised transcript segments and computes
// how many words per second the preacher is currently speaking.
// Falls back to 2.2 wps (typical sermon read-aloud pace) when there isn't
// enough data yet.
function estimateReadingWPS() {
  const now     = Date.now();
  const recent  = transcriptBuffer.filter(t => t.time > now - 15000);
  if (recent.length < 2) return 2.2;

  const totalWords = recent.reduce((sum, t) => {
    return sum + (t.wordCount || t.text.split(/\s+/).filter(Boolean).length);
  }, 0);
  const spanSecs = (recent[recent.length - 1].time - recent[0].time) / 1000;
  if (spanSecs < 1) return 2.2;

  // Clamp to a sane range — 0.5 wps (very slow/dramatic) to 5 wps (fast reader)
  return Math.max(0.5, Math.min(5, totalWords / spanSecs));
}

// ── Auto-advance detector ─────────────────────────────────────────────────
// Timing-based: measures the preacher's live reading pace (words/sec) from
// the transcript buffer, estimates how long the current verse should take to
// read at that pace, then advances when that time has elapsed.
//
// This adapts naturally to the preacher's style — slow dramatic reading gets
// more time; fast reading advances sooner.  A 15% grace period is added so
// we never cut off the last word.
//
// The explicit-reference path (processForReferences) overrides this and fires
// immediately whenever the preacher calls the next verse number directly.
function checkRangeAutoAdvance() {
  const now = Date.now();
  if (!rangeCurrentVerse || !rangeQueue.length || rangeAdvancing) return;
  if (now - rangeLastAdvanceAt < RANGE_ADVANCE_COOLDOWN_MS) return;
  if (!rangeVerseStartTime) return;

  const verseText      = rangeCurrentVerse.text || rangeCurrentVerse.kjv_text || '';
  const verseWordCount = verseText.split(/\s+/).filter(Boolean).length;
  const wps            = estimateReadingWPS();

  // How long this verse should take at the current pace.
  // In reading mode the pastor is reading scripture verbatim — tighten the
  // grace period so advances feel natural (8% vs 15% for conversational).
  const graceMultiplier = readingModeActive ? 1.08 : 1.15;
  const estimatedMs = (verseWordCount / wps) * 1000 * graceMultiplier;
  // Never advance in under 2s (reading mode) or 3s (normal) regardless of verse length
  const waitMs      = Math.max(readingModeActive ? 2000 : 3000, estimatedMs);
  const elapsed     = now - rangeVerseStartTime;

  if (elapsed >= waitMs) {
    rangeAdvancing     = true;
    rangeLastAdvanceAt = now;
    console.log(
      `[Range] Timing advance: ${verseWordCount} words @ ${wps.toFixed(1)} wps` +
      ` → estimated ${(estimatedMs/1000).toFixed(1)}s, elapsed ${(elapsed/1000).toFixed(1)}s`
    );
    advanceRangeQueue().finally(() => { rangeAdvancing = false; });
  }
}

// ── Topic Accumulator ─────────────────────────────────────────────────────
// Listens to the rolling speech stream and builds a topic word frequency map.
// Every 60s it extracts the top recurring content words and sends them to
// the worker to rebuild the topic library.
//
// The library is ready within 2-5 minutes of the sermon starting — by the
// time the preacher quotes anything substantive, the system already knows
// the thematic territory it's operating in.
//
// "Forgiveness, mercy, cleanse, restore" repeated across 3 minutes
//   → topic words: [forgiveness, mercy, cleanse, restore, iniquity, ...]
//   → worker builds library of top 80 matching verses
//   → fingerprint now searches 80 verses, not 31,000

const TOPIC_BUILD_INTERVAL_MS = 60 * 1000;   // rebuild every 60s
const TOPIC_WORD_MIN_COUNT     = 2;           // word must appear ≥ 2× to qualify
const TOPIC_WORD_MIN_IDF       = 3.0;         // only distinctive words (IDF threshold)
const TOPIC_MAX_WORDS          = 20;          // top 20 words drive the library

let topicWordCounts   = new Map();   // Map<word, count> — raw frequency from speech
let lastTopicBuild    = 0;
let topicBuildTimer   = null;

// Called on every final transcript — accumulates word frequencies
function accumulateTopicWords(transcript) {
  const norm = s => s.toLowerCase().replace(RE_NONALPHA, '').replace(RE_WHITESPACE, ' ').trim();
  const words = norm(transcript).split(' ')
    .filter(w => w.length >= 5);   // 5+ chars — skips most noise words naturally
  for (const w of words) {
    topicWordCounts.set(w, (topicWordCounts.get(w) || 0) + 1);
  }
}

// Extracts qualifying topic words and triggers a library build if due
async function maybeRebuildTopicLibrary() {
  const now = Date.now();
  if (now - lastTopicBuild < TOPIC_BUILD_INTERVAL_MS) return;
  lastTopicBuild = now;

  // Extract words that appear frequently AND are topically distinctive.
  // We ask the worker for IDF scores via a workerCall so we don't duplicate
  // the IDF map in server memory — the worker owns all Bible data.
  const candidates = [...topicWordCounts.entries()]
    .filter(([, count]) => count >= TOPIC_WORD_MIN_COUNT)
    .map(([word]) => word);

  if (candidates.length < 3) return;   // not enough signal yet — too early in sermon

  try {
    // Get IDF scores for candidates from worker, filter by threshold
    const msg = await workerCall('getIdfScores', { words: candidates }, 3000);
    const topicWords = (msg.words || [])
      .filter(([, idf]) => idf >= TOPIC_WORD_MIN_IDF)
      .sort((a, b) => {
        // Rank by frequency × IDF — words that are both common in speech AND distinctive in Bible
        const freqA = topicWordCounts.get(a[0]) || 0;
        const freqB = topicWordCounts.get(b[0]) || 0;
        return (freqB * b[1]) - (freqA * a[1]);
      })
      .slice(0, TOPIC_MAX_WORDS)
      .map(([word]) => word);

    if (topicWords.length < 2) return;

    const buildMsg = await workerCall('buildTopicLibrary', { topicWords }, 5000);
    if (buildMsg.size > 0) {
      console.log(`[Topic] Library rebuilt: ${buildMsg.size} verses for topic [${topicWords.slice(0, 4).join(', ')}...]`);
      broadcast({ type: 'topic-library', size: buildMsg.size, words: topicWords.slice(0, 6) });
    }
  } catch (err) {
    if (!err.message?.includes('timeout')) console.warn('[Topic] Library build error:', err.message);
  }
}

function resetTopicAccumulator() {
  topicWordCounts.clear();
  lastTopicBuild = 0;
  clearTimeout(topicBuildTimer);
}

// ── Sermon Context Accumulator ────────────────────────────────────────────
// A real sermon visits 30-50 scriptures across 20+ books in an hour.
// The preacher moves fast — sometimes 7 references in 2 minutes.
//
// The model: track the last 8 explicitly cited verses with timestamps.
// Context hint = that sliding citation window.
//
// In the worker, verses that are *neighbors* of recently cited verses
// (same chapter, within ±5 verses) get a gentle tie-breaker boost — max
// 1.15×. This resolves genuine ambiguity without overriding word match.
//
// The 87% fingerprint word score is always primary. Context only tips the
// scale when two candidates are very close.

const CONTEXT_WINDOW_MS  = 5 * 60 * 1000;   // citations older than 5 min expire
const CONTEXT_MAX_CITED  = 8;                // keep last 8 cited verses

const recentCitations = [];   // [{ book, chapter, verse, time }, ...]

function updateSermonContext(ref) {
  const now = Date.now();
  recentCitations.push({
    book:    ref.book,
    chapter: ref.chapter || null,
    verse:   ref.verse   || ref.verseStart || null,
    time:    now,
  });
  // Keep only the last N within the window
  const cutoff = now - CONTEXT_WINDOW_MS;
  while (recentCitations.length > CONTEXT_MAX_CITED ||
         (recentCitations.length > 0 && recentCitations[0].time < cutoff)) {
    recentCitations.shift();
  }
}

function getContextHint() {
  if (!recentCitations.length) return null;
  const now    = Date.now();
  const cutoff = now - CONTEXT_WINDOW_MS;
  // Return only citations still within the window, most recent first
  const active = recentCitations
    .filter(c => c.time >= cutoff)
    .map(c => ({ ...c, age: now - c.time }))
    .reverse();
  return active.length ? { citations: active } : null;
}

function resetSermonContext() {
  recentCitations.length = 0;
}

// ── API ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  ok: true,
  workerBasicReady,
  topicWords:   [...topicWordCounts.entries()].filter(([,c]) => c >= TOPIC_WORD_MIN_COUNT).length,
  lastTopicBuild: lastTopicBuild ? Math.round((Date.now() - lastTopicBuild) / 1000) + 's ago' : 'never',
}));

app.get('/api/settings', (_, res) => {
  const s = loadSettings();
  const safe = { ...s };
  if (safe.deepgramApiKey) safe.deepgramApiKey = safe.deepgramApiKey.slice(0, 8) + '…';
  res.json(safe);
});

app.post('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  saveSettings(updated);
  settings = updated;
  const obsChanged = req.body.obsEnabled !== undefined || req.body.obsUrl !== undefined || req.body.obsPassword !== undefined;
  if (obsChanged) connectOBS().catch(err => console.warn('[OBS] Reconnect-on-settings-change failed:', err.message));
  res.json({ ok: true });
});

app.get('/api/propresenter/test', async (_, res) => {
  res.json(await testProPresenterConnection());
});

app.post('/api/propresenter/send', async (req, res) => {
  const { verse } = req.body;
  if (!verse) return res.status(400).json({ error: 'No verse provided' });
  res.json({ ok: await sendToProPresenter(verse) });
});

app.post('/api/propresenter/clear', async (_, res) => {
  await clearProPresenter();
  res.json({ ok: true });
});

// Broadcast active look to all connected display windows via WebSocket
app.post('/api/look/apply', (req, res) => {
  const { look } = req.body;
  if (!look || typeof look !== 'object') return res.status(400).json({ error: 'No look provided' });
  broadcast({ type: 'look-update', look });
  res.json({ ok: true });
});

app.get('/api/obs/test', async (_, res) => {
  const s = loadSettings();
  const r = await testOBSConnection(s.obsUrl, s.obsPassword);
  res.json(r);
});

app.post('/api/obs/connect', async (_, res) => {
  await connectOBS();
  res.json({ ok: obsConnected });
});

app.get('/api/obs/sources', async (_, res) => {
  if (!obsConnected || !obsClient) return res.json({ sources: [] });
  try {
    const { inputs } = await obsClient.call('GetInputList', { inputKind: 'text_gdiplus_v3' });
    const mac = inputs?.length ? inputs : (await obsClient.call('GetInputList', { inputKind: 'text_ft2_source_v2' })).inputs || [];
    res.json({ sources: mac.map(i => i.inputName) });
  } catch { res.json({ sources: [] }); }
});

app.post('/api/range/next', async (_, res) => {
  if (!rangeQueue.length) return res.json({ ok: false, reason: 'no range active' });
  const verse = await advanceRangeQueue();
  res.json({ ok: true, verse: verse?.reference });
});

app.post('/api/range/clear', (_, res) => {
  clearRangeQueue();
  res.json({ ok: true });
});

app.post('/api/lookup', async (req, res) => {
  try {
    const { book, chapter, verse, verseEnd } = req.body;
    if (!book || !chapter) return res.status(400).json({ error: 'book and chapter required' });
    if (verseEnd && verseEnd !== verse) {
      const msg = await workerCall('rangeLookup', { book, chapter, verseStart: verse, verseEnd }, 5000);
      return res.json({ results: msg.results || [] });
    }
    if (verse) {
      const msg = await workerCall('directLookup', { book, chapter, verse }, 5000);
      return res.json({ result: msg.result });
    }
    return res.status(400).json({ error: 'verse required' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { query, limit } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    // Normalise for typed input: lowercase, strip sentence punctuation
    const normQuery = query.trim().toLowerCase().replace(/[.,!?;]/g, ' ');

    // Parse — inBibleMode=true so ambiguous book names (John, Mark, Luke, Acts…)
    // resolve correctly when typed explicitly rather than spoken mid-sermon
    const ref = parseSpokenReference(normQuery, true);

    if (ref && ref.book) {
      // ── Range (verseStart / verseEnd) ──────────────────────────────────────
      if (ref.verseStart != null && ref.verseEnd != null) {
        const msg = await workerCall('rangeLookup', {
          book: ref.book, chapter: ref.chapter,
          verseStart: ref.verseStart, verseEnd: ref.verseEnd,
        }, 5000);
        const verses = msg.results || [];
        if (verses.length) {
          if (verses.length > 1) setRangeQueue(verses);
          else clearRangeQueue();
          broadcastDetection(verses, 'direct', 1.0, 'viewer');
          return res.json({ result: verses[0], method: 'range', range: verses });
        }
      }

      // ── Multi-range (ranges array) ─────────────────────────────────────────
      if (ref.ranges?.length) {
        const allVerses = [];
        for (const { verseStart, verseEnd } of ref.ranges) {
          const msg = await workerCall('rangeLookup', {
            book: ref.book, chapter: ref.chapter, verseStart, verseEnd,
          }, 5000);
          allVerses.push(...(msg.results || []));
        }
        if (allVerses.length) {
          if (allVerses.length > 1) setRangeQueue(allVerses);
          else clearRangeQueue();
          broadcastDetection(allVerses, 'direct', 1.0, 'viewer');
          return res.json({ result: allVerses[0], method: 'range', range: allVerses });
        }
      }

      // ── Single verse ───────────────────────────────────────────────────────
      if (ref.verse != null) {
        const msg = await workerCall('directLookup', {
          book: ref.book, chapter: ref.chapter, verse: ref.verse,
        }, 5000);
        if (msg.result) {
          clearRangeQueue();
          broadcastDetection([msg.result], 'direct', 1.0, 'viewer');
          return res.json({ result: msg.result, method: 'reference' });
        }
      }

      // ── Whole chapter (e.g. "Psalm 23" or "John 3") ───────────────────────
      if (ref.chapter != null && ref.verse == null &&
          ref.verseStart == null && !ref.ranges?.length) {
        const msg = await workerCall('chapterLookup', {
          book: ref.book, chapter: ref.chapter,
        }, 5000);
        const verses = msg.results || [];
        if (verses.length) {
          setRangeQueue(verses);
          broadcastDetection(verses, 'direct', 1.0, 'viewer');
          return res.json({ result: verses[0], method: 'range', range: verses });
        }
      }
    }

    // ── Phrase / keyword fallback ──────────────────────────────────────────
    const msg = await workerCall('textSearch', { query, limit: limit || 8 }, 5000);
    res.json({ results: msg.results || [], method: 'text' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/test-transcript', async (req, res) => {
  const text = req.body?.text;
  if (!text) return res.json({ error: 'no text' });
  broadcast({ type: 'transcript', text, isFinal: true, confidence: 1.0 });
  const foundRef = await processForReferences(text, true);
  if (!foundRef && workerBasicReady) {
    const foundV = await processVerbatim(text);
    if (!foundV) runFingerprintSearch(text);
  }
  res.json({ ok: true, foundRef });
});

// Unified start endpoint — body.engine selects 'deepgram' (cloud) or 'vosk' (offline).
// Default is deepgram for backward compatibility.
app.post('/api/start-listening', async (req, res) => {
  const engine = String(req.body?.engine || 'deepgram').toLowerCase();
  if (engine === 'vosk' || engine === 'offline' || engine === 'browser') {
    return res.json(await startVosk());
  }
  return res.json(await startDeepgram(req.body || {}));
});

app.post('/api/stop-listening', async (_, res) => {
  // Stop whichever engine is active. Both calls are idempotent / no-op if inactive.
  if (voskActive) await stopVosk();
  if (deepgramConnection) await stopDeepgram();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────
// CONTENT STUDIO — sermon notes & sermon points
//   Saved sessions live as JSON in <app-data>/sessions/<id>.json. Generation
//   runs through a local Ollama instance — fully offline. Anti-hallucination
//   guardrails: only verses that actually fired during the session are
//   passed to the model, and any scripture refs in the response that aren't
//   in that whitelist are stripped post-hoc.
// ─────────────────────────────────────────────────────────────────────────
const SESSIONS_DIR = process.env.KAIRO_APP_DATA_DIR
  ? path.join(process.env.KAIRO_APP_DATA_DIR, 'sessions')
  : path.join(__dirname, '..', 'databases', 'sessions');

function ensureSessionsDir() { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); }
function sessionPath(id) {
  if (!/^[A-Za-z0-9_\-]+$/.test(String(id || ''))) return null;
  return path.join(SESSIONS_DIR, `${id}.json`);
}
function readSession(id) {
  const p = sessionPath(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeSession(s) {
  ensureSessionsDir();
  const p = sessionPath(s.id);
  if (!p) throw new Error('invalid session id');
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

app.get('/api/sessions', (_req, res) => {
  ensureSessionsDir();
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')); } catch {}
  const list = files.map(f => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      return {
        id: s.id,
        title: s.title || s.date || s.id,
        date: s.date,
        durationMin: s.durationMin || 0,
        verseCount: (s.verses || []).length,
        wordCount: (s.transcript || '').split(/\s+/).filter(Boolean).length,
        hasNote: !!(s.generated && s.generated.note),
        hasPoints: !!(s.generated && s.generated.points),
        createdAt: s.createdAt,
      };
    } catch { return null; }
  }).filter(Boolean);
  list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json({ sessions: list });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = readSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});

// Hard caps on session size. Even an hour-long sermon rarely exceeds ~10k
// words; these limits give plenty of headroom and prevent a misbehaving
// client from filling the disk.
const MAX_TRANSCRIPT_CHARS = 200_000;
const MAX_VERSES_PER_SESSION = 500;

app.post('/api/sessions', (req, res) => {
  const body = req.body || {};
  const transcript = String(body.transcript || '').trim().slice(0, MAX_TRANSCRIPT_CHARS);
  const verses = (Array.isArray(body.verses) ? body.verses : [])
    .slice(0, MAX_VERSES_PER_SESSION)
    .map(v => ({
      ref:  String(v?.ref  || '').slice(0, 80),
      text: String(v?.text || '').slice(0, 4000),
      time: String(v?.time || '').slice(0, 16),
    }))
    .filter(v => v.ref);
  if (!transcript && !verses.length && !body.id) {
    return res.status(400).json({ error: 'empty session — record some audio first' });
  }
  const now = new Date();
  const id = body.id ? String(body.id).slice(0, 64) : now.toISOString().replace(/[:.]/g, '-');
  if (!/^[A-Za-z0-9_\-]+$/.test(id)) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  const existing = body.id ? readSession(body.id) : null;
  const session = existing || {};
  session.id          = id;
  session.title       = body.title       ?? session.title       ?? `Session — ${now.toLocaleDateString()}`;
  session.date        = body.date        ?? session.date        ?? now.toISOString().slice(0, 10);
  session.durationMin = body.durationMin ?? session.durationMin ?? 0;
  session.transcript  = transcript || session.transcript || '';
  session.verses      = verses.length ? verses : (session.verses || []);
  session.generated   = session.generated || {};
  session.createdAt   = session.createdAt || now.toISOString();
  session.updatedAt   = now.toISOString();
  try { writeSession(session); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, id, session });
});

app.delete('/api/sessions/:id', (req, res) => {
  const p = sessionPath(req.params.id);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(p); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

function ollamaUrl()   { return (loadSettings().ollamaUrl   || 'http://localhost:11434').replace(/\/+$/, ''); }
function ollamaModel() { return  loadSettings().ollamaModel || 'qwen2.5:7b-instruct'; }

app.get('/api/llm/status', async (_req, res) => {
  const url = ollamaUrl();
  try {
    const r = await axios.get(url + '/api/tags', { timeout: 1500 });
    const models = (r.data?.models || []).map(m => m.name);
    res.json({ ok: true, url, models, configuredModel: ollamaModel() });
  } catch (e) {
    res.json({ ok: false, url, error: e.code || e.message });
  }
});

// Streams Ollama's `/api/pull` progress through to the client as NDJSON.
// Client disconnect = pull cancellation: we destroy the upstream stream so
// Ollama stops fetching layers.
// Ollama model names: <namespace>/<name>:<tag> — alphanumerics, dots, dashes,
// underscores, slashes, colons. Reject anything else so we don't pass weird
// strings (or accidental shell metacharacters) downstream.
const MODEL_NAME_RE = /^[A-Za-z0-9._:\-\/]{1,128}$/;

app.post('/api/llm/pull', async (req, res) => {
  const model = String(req.body?.model || ollamaModel()).trim();
  if (!model || !MODEL_NAME_RE.test(model)) {
    return res.status(400).json({ error: 'invalid model name' });
  }
  const url = ollamaUrl();

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let upstream;
  try {
    upstream = await axios.post(url + '/api/pull',
      { name: model, stream: true },
      { responseType: 'stream', timeout: 0 }
    );
  } catch (e) {
    res.write(JSON.stringify({ error: 'Cannot reach Ollama: ' + (e.code || e.message) }) + '\n');
    return res.end();
  }

  let cancelled = false;
  req.on('close', () => {
    cancelled = true;
    try { upstream.data.destroy(); } catch {}
  });
  upstream.data.on('data', chunk => { if (!cancelled) res.write(chunk); });
  upstream.data.on('end',   () => res.end());
  upstream.data.on('error', e => {
    try { res.write(JSON.stringify({ error: e.message }) + '\n'); } catch {}
    res.end();
  });
});

// Hard cap on transcript words shipped to the model — keeps inference fast
// on 7B models and prevents context-window overflows. Long sermons keep the
// most recent 4k words; the user can export the full transcript separately.
const TRANSCRIPT_WORD_CAP = 4000;
function clampTranscript(t) {
  if (!t) return '';
  const words = t.split(/\s+/);
  return words.length <= TRANSCRIPT_WORD_CAP ? t : words.slice(-TRANSCRIPT_WORD_CAP).join(' ');
}

const NOTE_PROMPT = `You are a sermon-transcript analyst. Produce a faithful, structured sermon note from the transcript and verified scripture list provided.

STRICT RULES:
1. Use ONLY material present in the transcript.
2. Cite scriptures only by reference — never paraphrase or reword Bible text.
3. Only reference scriptures from the verified list. Never invent references.
4. If the transcript is too short or unclear for a section, return an empty array — do not pad.
5. Output JSON ONLY matching this schema:
{
  "title": string,
  "summary": string,
  "sections": [
    { "heading": string, "body": string, "scriptures": [string] }
  ],
  "closing": string
}`;

const POINTS_PROMPT = `You are a sermon-transcript analyst. Extract the preacher's main points as a bullet outline.

STRICT RULES:
1. Use ONLY material present in the transcript.
2. Each point must be grounded in something the preacher actually said.
3. Tie each point to one scripture from the verified list when possible — otherwise leave scripture as null.
4. supportingQuote, if present, must be an EXACT short fragment from the transcript (max 25 words). If no clean quote, use null.
5. 3–7 points, ordered by appearance in the transcript.
6. Output JSON ONLY matching this schema:
{
  "title": string,
  "mainTheme": string,
  "points": [
    { "point": string, "explanation": string, "scripture": string | null, "supportingQuote": string | null }
  ]
}`;

function buildUserPayload(session) {
  const verseList = (session.verses || [])
    .map(v => `- ${v.ref}${v.text ? `: "${String(v.text).replace(/"/g, "'")}"` : ''}`)
    .join('\n') || '(none — preacher did not cite any tracked verses)';
  return `VERIFIED SCRIPTURES (the only references you may cite):
${verseList}

TRANSCRIPT:
${clampTranscript(session.transcript || '')}`;
}

function sanitizeNote(out, allowed) {
  if (!out || typeof out !== 'object') return null;
  const ok = new Set(allowed);
  const sections = Array.isArray(out.sections) ? out.sections : [];
  return {
    title:   String(out.title   || '').slice(0, 200),
    summary: String(out.summary || '').slice(0, 600),
    sections: sections.slice(0, 12).map(s => ({
      heading:    String(s.heading || '').slice(0, 120),
      body:       String(s.body    || '').slice(0, 1200),
      scriptures: Array.isArray(s.scriptures) ? s.scriptures.filter(r => ok.has(r)) : [],
    })).filter(s => s.heading || s.body),
    closing: String(out.closing || '').slice(0, 400),
  };
}

function sanitizePoints(out, allowed) {
  if (!out || typeof out !== 'object') return null;
  const ok = new Set(allowed);
  const points = Array.isArray(out.points) ? out.points : [];
  return {
    title:     String(out.title     || '').slice(0, 200),
    mainTheme: String(out.mainTheme || '').slice(0, 400),
    points: points.slice(0, 10).map(p => ({
      point:           String(p.point       || '').slice(0, 200),
      explanation:     String(p.explanation || '').slice(0, 800),
      scripture:       p.scripture && ok.has(p.scripture) ? p.scripture : null,
      supportingQuote: p.supportingQuote ? String(p.supportingQuote).slice(0, 250) : null,
    })).filter(p => p.point),
  };
}

app.post('/api/content/generate', async (req, res) => {
  const { sessionId, type } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (type !== 'note' && type !== 'points') return res.status(400).json({ error: 'type must be note|points' });

  const session = readSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!(session.transcript || '').trim()) {
    return res.status(400).json({ error: 'session has no transcript' });
  }

  const url = ollamaUrl();
  const model = ollamaModel();
  const systemPrompt = type === 'note' ? NOTE_PROMPT : POINTS_PROMPT;

  let raw;
  try {
    const r = await axios.post(url + '/api/chat', {
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2, num_ctx: 8192 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: buildUserPayload(session) },
      ],
    }, { timeout: 180_000 });
    raw = r.data?.message?.content || '';
  } catch (e) {
    const msg = e.response?.data?.error || e.code || e.message;
    return res.status(502).json({ error: `Ollama request failed: ${msg}`, url, model });
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return res.status(502).json({ error: 'Model returned invalid JSON', raw: raw.slice(0, 500) }); }

  const allowed = (session.verses || []).map(v => v.ref);
  const cleaned = type === 'note' ? sanitizeNote(parsed, allowed) : sanitizePoints(parsed, allowed);
  if (!cleaned) return res.status(502).json({ error: 'Model output failed validation' });

  session.generated = session.generated || {};
  session.generated[type] = { ...cleaned, generatedAt: new Date().toISOString(), model };
  session.updatedAt = new Date().toISOString();
  try { writeSession(session); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  res.json({ ok: true, type, content: session.generated[type] });
});

// ── Shared transcript pipeline ───────────────────────────────────────────
// Called by both the Deepgram WebSocket handler and the /api/stream-text
// endpoint (browser Web Speech API path). Broadcasts the transcript to
// clients, runs reference detection on interim + final, and dispatches
// verbatim / fingerprint / streaming-anchor searches on final segments.
//
// `speechFinal` signals utterance boundary — for Deepgram it's their
// endpointing flag; for browser Web Speech API we set it = isFinal, since
// each final result is its own utterance.
async function handleTranscriptSegment(transcript, isFinal, confidence, speechFinal) {
  broadcast({ type: 'transcript', text: transcript, isFinal, confidence });

  // ── Interim transcripts ───────────────────────────────────────
  // Reference parser fires on interim for < 2s explicit citations.
  // Fingerprint also fires on longer interim segments so paraphrase
  // detection doesn't wait for the endpoint (300-1200ms delay).
  if (!isFinal) {
    if (workerBasicReady) {
      let foundRef = await processForReferences(transcript, false);
      if (!foundRef && referenceContext.isValid) {
        const partial = resolvePartialReference(transcript);
        if (partial && partial.verse) {
          try {
            const msg = await workerCall('directLookup', { book: partial.book, chapter: partial.chapter, verse: partial.verse }, 3000);
            if (msg.result) {
              broadcastDetection([msg.result], 'direct', 1.0, 'viewer');
              foundRef = true;
            }
          } catch {}
        }
      }
      if (!foundRef) {
        const interimWords = transcript.split(RE_SPACES).filter(Boolean).length;
        const now = Date.now();
        if (rangeQueue.length) checkRangeAutoAdvance();
        if (interimWords >= 6 && now - lastInterimVerbatim > INTERIM_VERBATIM_MS) {
          lastInterimVerbatim = now;
          processVerbatim(transcript).catch(err => console.warn('[Detection] processVerbatim failed:', err.message));
        }
        if (interimWords >= 6 && now - lastFingerprintSearch > FINGERPRINT_INTERVAL_MS) {
          lastFingerprintSearch = now;
          runFingerprintSearch(transcript, true);
        }
      }
    }
    return;
  }

  // ── Final transcript ───────────────────────────────────────────
  const now = Date.now();
  const wordCount = transcript.split(/\s+/).filter(Boolean).length;
  transcriptBuffer.push({ text: transcript, time: now, wordCount });
  while (transcriptBuffer.length && transcriptBuffer[0].time < now - 90000) transcriptBuffer.shift();
  hasNewTranscript = true;

  if (workerBasicReady) {
    processStreamText(transcript).catch(() => {});
  }

  accumulateTopicWords(transcript);
  maybeRebuildTopicLibrary();

  if (rangeQueue.length) checkRangeAutoAdvance();

  let foundRef = await processForReferences(transcript, true);

  if (!foundRef && referenceContext.isValid) {
    const partial = resolvePartialReference(transcript);
    if (partial) {
      try {
        let verses = [];
        if (partial.verseStart && partial.verseEnd && partial.verseEnd !== partial.verseStart) {
          const msg = await workerCall('rangeLookup', { book: partial.book, chapter: partial.chapter, verseStart: partial.verseStart, verseEnd: partial.verseEnd }, 3000);
          verses = msg.results || [];
        } else if (partial.verse) {
          const msg = await workerCall('directLookup', { book: partial.book, chapter: partial.chapter, verse: partial.verse }, 3000);
          if (msg.result) verses = [msg.result];
        }
        if (verses.length) {
          console.log(`[Context] Resolved partial ref "verse ${partial.verse || partial.verseStart}" → ${partial.book} ${partial.chapter}:${partial.verse || partial.verseStart}`);
          if (verses.length > 1) setRangeQueue(verses);
          else clearRangeQueue();
          broadcastDetection(verses, 'direct', 1.0, 'viewer');
          foundRef = true;
        }
      } catch (err) {
        console.warn('[Context] Partial ref lookup error:', err.message);
      }
    }
  }

  if (transcriptBuffer.length) {
    transcriptBuffer[transcriptBuffer.length - 1].hasRef = !!foundRef;
  }

  const sentenceFlushed = speechFinal
    ? sentenceBuffer.forceFlush()
    : sentenceBuffer.append(transcript);
  const textForExpensive = sentenceFlushed || sentenceBuffer.checkTimeout();

  if (workerBasicReady && textForExpensive) {
    const canFingerprint = now - lastFingerprintSearch > FINGERPRINT_INTERVAL_MS;
    lastFingerprintSearch = now;
    await Promise.all([
      processVerbatim(textForExpensive),
      canFingerprint
        ? runFingerprintSearch(textForExpensive, true, !foundRef)
        : Promise.resolve(),
    ]);
  } else if (workerBasicReady && !textForExpensive) {
    const interimWords = transcript.split(/\s+/).filter(Boolean).length;
    if (interimWords >= 8) {
      processVerbatim(transcript).catch(err => console.warn('[Detection] processVerbatim failed:', err.message));
    }
  }

  if (speechFinal && workerBasicReady) {
    const bufferText = transcriptBuffer.map(t => t.text).join(' ').trim();
    if (bufferText && bufferText !== textForExpensive) {
      await Promise.all([
        processVerbatim(bufferText),
        runFingerprintSearch(bufferText, true, !foundRef),
      ]);
    }
  }
}

// ── Vosk (offline STT) ────────────────────────────────────────────────────
// Local, no-internet engine. Audio streams from the client over the same
// WebSocket the Deepgram path uses. Recognizer results are routed through
// the shared `handleTranscriptSegment` so detection / broadcast / viewer
// behaviour is identical to Deepgram.
function loadVoskModel() {
  if (voskModel) return voskModel;
  if (!fs.existsSync(VOSK_MODEL_PATH) || !fs.existsSync(path.join(VOSK_MODEL_PATH, 'conf', 'model.conf'))) {
    const e = new Error(`Vosk model not found at ${VOSK_MODEL_PATH}. Run: npm run vosk:install`);
    e.code = 'VOSK_MODEL_MISSING';
    throw e;
  }
  if (!voskLib) voskLib = require('vosk-koffi');
  // Quiet Vosk's verbose log spam — we only want errors.
  try { voskLib.setLogLevel(-1); } catch {}
  voskModel = new voskLib.Model(VOSK_MODEL_PATH);
  return voskModel;
}

async function startVosk() {
  if (connectionState === 'connected' || connectionState === 'connecting') {
    return { error: 'Already listening' };
  }
  try {
    connectionState = 'connecting';
    broadcast({ type: 'connection-state', state: 'connecting', engine: 'vosk' });

    const model = loadVoskModel();
    voskRecognizer = new voskLib.Recognizer({ model, sampleRate: VOSK_SAMPLE_RATE });
    try { voskRecognizer.setWords(false); } catch {}
    try { voskRecognizer.setPartialWords(false); } catch {}

    voskActive = true;
    voskLastPartial = '';
    connectionState = 'connected';
    broadcast({ type: 'connection-state', state: 'connected', engine: 'vosk' });
    return { ok: true, engine: 'vosk' };
  } catch (err) {
    voskActive = false;
    if (voskRecognizer) { try { voskRecognizer.free(); } catch {} voskRecognizer = null; }
    connectionState = 'error';
    const friendly = err.code === 'VOSK_MODEL_MISSING'
      ? 'Offline model missing. Run "npm run vosk:install" to download it (~40MB).'
      : `Vosk failed to start: ${err.message}`;
    broadcast({ type: 'connection-state', state: 'error', error: friendly, errorKind: err.code === 'VOSK_MODEL_MISSING' ? 'model-missing' : 'unknown' });
    return { error: friendly };
  }
}

// vosk-koffi's result methods return already-parsed objects (unlike upstream
// `vosk` which returns JSON strings). Accept both for forward-compat.
function _voskUnpack(out) {
  if (!out) return {};
  if (typeof out === 'string') {
    try { return JSON.parse(out); } catch { return {}; }
  }
  return out;
}

async function stopVosk() {
  voskActive = false;
  clearTimeout(voskPartialFlushTimer);
  voskPartialFlushTimer = null;
  if (voskRecognizer) {
    // Flush any remaining audio so the last utterance lands as a final transcript
    try {
      const tail = (_voskUnpack(voskRecognizer.finalResult()).text || '').trim();
      if (tail) {
        await handleTranscriptSegment(tail, true, 0.9, true).catch(() => {});
      }
    } catch {}
    try { voskRecognizer.free(); } catch {}
    voskRecognizer = null;
  }
  voskLastPartial = '';
  connectionState = 'disconnected';
  broadcast({ type: 'connection-state', state: 'disconnected' });
}

// Called from the WebSocket binary-message handler when Vosk is the active engine.
function feedVoskAudio(buffer) {
  if (!voskActive || !voskRecognizer) return;
  let isFinal = false;
  try {
    isFinal = voskRecognizer.acceptWaveform(buffer);
  } catch (err) {
    console.warn('[Vosk] acceptWaveform error:', err.message);
    return;
  }
  if (isFinal) {
    try {
      const finalText = (_voskUnpack(voskRecognizer.result()).text || '').trim();
      voskLastPartial = '';
      if (finalText) {
        handleTranscriptSegment(finalText, true, 0.9, true).catch(err => {
          console.error('[Vosk] final handler error:', err.message);
        });
      }
    } catch (err) {
      console.warn('[Vosk] result parse error:', err.message);
    }
  } else {
    // Throttle partials — Vosk emits one per chunk and we don't need that rate
    if (voskPartialFlushTimer) return;
    voskPartialFlushTimer = setTimeout(() => {
      voskPartialFlushTimer = null;
      if (!voskActive || !voskRecognizer) return;
      try {
        const partial = (_voskUnpack(voskRecognizer.partialResult()).partial || '').trim();
        if (!partial || partial === voskLastPartial) return;
        voskLastPartial = partial;
        handleTranscriptSegment(partial, false, 0.85, false).catch(err => {
          console.error('[Vosk] partial handler error:', err.message);
        });
      } catch {}
    }, VOSK_PARTIAL_FLUSH_MS);
  }
}

// ── Deepgram ──────────────────────────────────────────────────────────────
async function startDeepgram(config = {}) {
  if (connectionState === 'connected' || connectionState === 'connecting') {
    return { error: 'Already listening' };
  }

  deepgramUserStopped = false;
  deepgramLastConfig  = config;   // save for auto-reconnect

  const key = settings.deepgramApiKey || loadSettings().deepgramApiKey;
  if (!key) {
    broadcast({ type: 'listening-error', error: 'No Deepgram API key configured' });
    return { error: 'No Deepgram API key' };
  }

  transcriptBuffer      = [];
  lastFingerprintSearch = 0;
  hasNewTranscript      = false;
  inBibleMode           = false;
  interimDetectedRef    = null;
  lastInterimVerbatim   = 0;
  lastDirectRefTime     = 0;
  resetSermonContext();
  resetTopicAccumulator();
  resetReadingMode();
  sentenceBuffer = new SentenceBuffer(4000);
  ensembleCache.clear();
  audioRingBuffer = [];
  audioRingBytes  = 0;

  // Clear streaming automaton state so a new session starts fresh.
  if (workerBasicReady) {
    workerCall('streamReset', {}, 1000).catch(() => {});
  }

  try {
    connectionState = 'connecting';
    broadcast({ type: 'connection-state', state: 'connecting' });

    const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
    const dg = createClient(key);

    deepgramConnection = dg.listen.live({
      model: 'nova-2', language: 'en-US', smart_format: true, punctuate: true,
      interim_results: true, utterance_end_ms: 1200, endpointing: 300,
      encoding: 'linear16', sample_rate: 16000, channels: 1,
      no_delay: true, filler_words: false, diarize: false,
      keywords: [
        'Genesis:2','Exodus:2','Leviticus:3','Numbers:1','Deuteronomy:4',
        'Joshua:2','Judges:1','Ruth:1','Samuel:2','Kings:1','Chronicles:2',
        'Ezra:2','Nehemiah:3','Esther:2','Job:1','Psalms:2','Psalm:2','Proverbs:2',
        'Ecclesiastes:4','Isaiah:2','Jeremiah:2','Lamentations:4','Ezekiel:3','Daniel:2',
        'Hosea:3','Joel:2','Amos:2','Obadiah:3','Jonah:2','Micah:2',
        'Nahum:3','Habakkuk:4','Zephaniah:4','Haggai:3','Zechariah:3','Malachi:3',
        'Matthew:2','Mark:1','Luke:2','John:1','Acts:1','Romans:2',
        'Corinthians:3','Galatians:3','Ephesians:3','Philippians:4','Colossians:3',
        'Thessalonians:4','Timothy:2','Titus:2','Philemon:3',
        'Hebrews:2','James:1','Peter:1','Jude:2','Revelation:2',
        'Chapter:2','Verse:2','Scripture:2',
        'brethren:2','righteous:2','salvation:2','covenant:2',
      ],
    });

    return await new Promise((resolve) => {
      deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
        connectionState = 'connected';
        broadcast({ type: 'connection-state', state: 'connected' });
        deepgramLastTranscriptAt = Date.now();

        // ── KeepAlive ping every 8 s ─────────────────────────────────────
        // Deepgram silently drops WebSocket connections that go quiet for
        // ~10-15 minutes. Sending a keepAlive packet every 8 s prevents that.
        clearInterval(deepgramKeepAliveTimer);
        deepgramKeepAliveTimer = setInterval(() => {
          try { deepgramConnection?.keepAlive?.(); } catch {}
        }, 8000);

        // ── Silence watchdog every 30 s ──────────────────────────────────
        // If we haven't received ANY transcript for 30 s while "connected",
        // the connection has silently stalled — force a reconnect.
        clearInterval(deepgramSilenceWatchdog);
        deepgramSilenceWatchdog = setInterval(() => {
          if (connectionState !== 'connected' || deepgramUserStopped) return;
          const silentMs = Date.now() - deepgramLastTranscriptAt;
          if (silentMs > 30000) {
            console.warn(`[Deepgram] No transcript for ${(silentMs/1000).toFixed(0)}s — reconnecting…`);
            clearInterval(deepgramKeepAliveTimer);
            clearInterval(deepgramSilenceWatchdog);
            connectionState = 'disconnected';
            broadcast({ type: 'connection-state', state: 'reconnecting' });
            startDeepgram(deepgramLastConfig).catch(err =>
              console.error('[Deepgram] Silence-watchdog reconnect failed:', err.message)
            );
          }
        }, 30000);

        resolve({ ok: true });
      });

      deepgramConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
        try {
          const alt = data.channel?.alternatives?.[0];
          if (!alt?.transcript?.trim()) return;
          deepgramLastTranscriptAt = Date.now();  // stamp every received segment

          await handleTranscriptSegment(
            alt.transcript,
            data.is_final,
            alt.confidence || 0,
            data.speech_final || false,
          );
        } catch (err) {
          console.error('[Deepgram] Transcript handler error:', err.message);
        }
      });

      deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
        clearInterval(deepgramKeepAliveTimer);
        clearInterval(deepgramSilenceWatchdog);
        const rawMsg = err?.message || err?.reason || err?.description
          || (typeof err === 'string' ? err : JSON.stringify(err));
        const code = err?.code || err?.statusCode || err?.status;
        const lc   = (rawMsg || '').toLowerCase();
        // Classify so the UI can surface something actionable.
        let kind = 'unknown';
        let friendly = rawMsg;
        if (code === 401 || code === 403 || lc.includes('unauthorized') || lc.includes('invalid api key') || lc.includes('forbidden')) {
          kind = 'auth';
          friendly = 'Deepgram rejected the API key. Open Settings → paste a valid key.';
        } else if (code === 429 || lc.includes('quota') || lc.includes('rate limit') || lc.includes('insufficient')) {
          kind = 'quota';
          friendly = 'Deepgram quota or rate limit reached. Check your Deepgram balance.';
        } else if (lc.includes('enotfound') || lc.includes('econnrefused') || lc.includes('etimedout') || lc.includes('network') || lc.includes('getaddrinfo')) {
          kind = 'network';
          friendly = 'Network error reaching Deepgram. Check your internet connection.';
        }
        console.error(`[Deepgram] Error (${kind}):`, rawMsg);
        connectionState = 'error';
        broadcast({ type: 'connection-state', state: 'error', error: friendly, errorKind: kind });
        resolve({ error: friendly, errorKind: kind });
      });

      deepgramConnection.on(LiveTranscriptionEvents.Close, (evt) => {
        // SDK hands us a CloseEvent — extract the actual numeric code + reason
        const closeCode   = (evt && typeof evt === 'object' && 'code' in evt) ? evt.code : evt;
        const closeReason = (evt && typeof evt === 'object' && evt.reason) ? evt.reason : '';
        const closeDesc   = closeReason ? `${closeCode} "${closeReason}"` : String(closeCode);

        // Closed before Open fired = connection rejected
        if (connectionState === 'connecting') {
          const msg = `Deepgram closed before connecting (code ${closeDesc})`;
          console.error('[Deepgram]', msg);
          connectionState = 'error';
          resolve({ error: msg });
          return;
        }
        clearInterval(deepgramKeepAliveTimer);
        clearInterval(deepgramSilenceWatchdog);
        connectionState = 'disconnected';
        broadcast({ type: 'connection-state', state: 'disconnected' });

        // Auto-reconnect unless the user explicitly stopped
        if (!deepgramUserStopped) {
          console.log(`[Deepgram] Connection closed (code ${closeDesc}) — reconnecting in 1.5s…`);
          broadcast({ type: 'connection-state', state: 'reconnecting' });
          // Submit any buffered audio via REST before reconnecting
          submitDeepgramRestFallback().catch(err => console.warn('[Deepgram] REST fallback dispatch failed:', err.message));
          setTimeout(() => {
            if (!deepgramUserStopped) {
              startDeepgram(deepgramLastConfig).catch(err => {
                console.error('[Deepgram] Reconnect failed:', err.message);
              });
            }
          }, 1500);
        }
      });

      setTimeout(() => {
        if (connectionState === 'connecting') {
          resolve({ error: 'Deepgram connection timeout — check your API key' });
        }
      }, 10000);
    });
  } catch (err) {
    connectionState = 'error';
    return { error: err.message };
  }
}

async function stopDeepgram() {
  deepgramUserStopped = true;   // prevent auto-reconnect
  if (deepgramConnection) {
    try { deepgramConnection.requestClose(); } catch {}
    deepgramConnection = null;
  }
  // Defensive: the ws-close handler clears these too, but stopDeepgram() can
  // be called from paths where the close event may not fire (or fires late).
  if (deepgramKeepAliveTimer)  { clearInterval(deepgramKeepAliveTimer);  deepgramKeepAliveTimer  = null; }
  if (deepgramSilenceWatchdog) { clearInterval(deepgramSilenceWatchdog); deepgramSilenceWatchdog = null; }
  connectionState = 'disconnected';
  broadcast({ type: 'connection-state', state: 'disconnected' });
}

// ── Range advance via explicit reference (shared helper) ─────────────────
function tryRangeAdvanceByRef(verses) {
  if (!rangeCurrentVerse || !rangeQueue.length || verses.length !== 1 || rangeAdvancing) return false;
  const nextInQueue = rangeQueue[0];
  if (nextInQueue && verses[0].book === nextInQueue.book &&
      verses[0].chapter === nextInQueue.chapter && verses[0].verse === nextInQueue.verse) {
    console.log(`[Range] Explicit ref match "${verses[0].reference}" → advancing`);
    rangeAdvancing = true;
    rangeLastAdvanceAt = Date.now();
    advanceRangeQueue().finally(() => { rangeAdvancing = false; });
    return true;
  }
  return false;
}

// ── Streaming anchor detection ────────────────────────────────────────────
// Every final word is fed into the worker's 4-gram anchor trie + alignment
// tracker (Layer 1 + Layer 2). No sentence buffer, no throttle.
//
//   • Anchor-only hits (4 distinctive words match) → 'suggestions' at 0.80.
//   • Confirmed hits (≥6 words align in sequence) → 'viewer' at 0.90+.
//
// Ties broken by:
//   1. Confirmed > anchor-only
//   2. Topic library membership (sermon's active theme)
//   3. Chapter proximity to recent citations (±5 chapters, decaying with age)
//   4. Longer match beats shorter
async function processStreamText(text) {
  if (!workerBasicReady || !text) return;
  try {
    const msg = await workerCall('streamText', { text }, 1500);
    const results = msg.results || [];
    if (!results.length) return;

    const ranked = rankStreamHits(results);

    const confirmed = ranked.filter(r => r.confirmed);
    const anchors   = ranked.filter(r => !r.confirmed);

    if (confirmed.length) {
      const top = confirmed.slice(0, 5);
      broadcastDetection(top, 'stream', top[0].similarity || 0.90, 'viewer');
    }
    if (anchors.length) {
      const top = anchors.slice(0, 5);
      broadcastDetection(top, 'stream', top[0].similarity || 0.80, 'suggestions');
    }
  } catch (err) {
    if (!err.message?.includes('timeout')) {
      console.warn('[Stream] anchor search error:', err.message);
    }
  }
}

// Rank stream hits by contextual signals so when 3 verses share a 4-gram
// (e.g. "lift up your heads" in Ps 24:7, Ps 24:9, Luke 21:28), the one
// closest to the sermon's active theme + recent citations sorts first.
function rankStreamHits(results) {
  const hints = getContextHint();
  const now   = Date.now();

  return results
    .map(r => {
      let score = 0;

      // Confirmed alignments beat anchor-only
      if (r.confirmed) score += 1000;
      // Longer matches beat shorter
      score += (r.matched || r.depth || 0) * 10;
      // Topic library: verse is in the sermon's active thematic frame
      if (r.inTopicLibrary) score += 50;
      // Recent-citation proximity — +40 for exact chapter, decaying with age
      if (hints?.citations) {
        for (const c of hints.citations) {
          if (c.book !== r.book) continue;
          const chapDelta = Math.abs((c.chapter || 0) - r.chapter);
          if (chapDelta > 5) continue;
          const recency = Math.max(0, 1 - c.age / (5 * 60 * 1000));
          score += (40 - chapDelta * 6) * recency;
        }
      }

      return { ...r, _rank: score };
    })
    .sort((a, b) => b._rank - a._rank);
}

// ── Reference detection ───────────────────────────────────────────────────
// isFinal: true → normal flow (can auto-send to PP)
// isFinal: false → from interim → route to suggestions, lighter dedup
async function processForReferences(transcript, isFinal) {
  if (!workerBasicReady) return false;
  const refs = parseAllSpokenReferences(transcript, inBibleMode);
  if (!refs.length) {
    // No full refs, but the preacher may have named a bare book ("Exodus…")
    // ahead of a monologue that ends with "chapter 3 verse 13". Update the
    // reference context so resolvePartialReference can resolve it later.
    const bareBooks = detectBookMentions(transcript, inBibleMode);
    if (bareBooks.length) {
      // Take the last mention — most recent intent wins.
      const book = bareBooks[bareBooks.length - 1];
      referenceContext.update(book, null);   // preserves previous chapter
      inBibleMode = true;
      clearTimeout(bibleModeClearTimer);
      bibleModeClearTimer = setTimeout(() => { inBibleMode = false; }, 30000);
    }
    return false;
  }

  for (const ref of refs) {
    const { book, chapter, verse, verseStart, verseEnd, ranges } = ref;

    // Even a book-or-book+chapter-only ref is meaningful context. Record it
    // before bailing so a split-final continuation ("from verse 10 to 12")
    // resolves against the *current* book/chapter instead of a stale one.
    if (book) {
      inBibleMode = true;
      clearTimeout(bibleModeClearTimer);
      bibleModeClearTimer = setTimeout(() => { inBibleMode = false; }, 30000);
      if (chapter) referenceContext.update(book, chapter);
    }

    if (!verse && !verseStart && !ranges) continue; // need at least a verse number

    try {
      let verses = [];

      if (ranges && ranges.length > 1) {
        for (const r of ranges) {
          const msg = await workerCall('rangeLookup', { book, chapter, verseStart: r.verseStart, verseEnd: r.verseEnd }, 8000);
          verses.push(...(msg.results || []));
        }
      } else if (verseStart && verseEnd && verseEnd !== verseStart) {
        const msg = await workerCall('rangeLookup', { book, chapter, verseStart, verseEnd }, 8000);
        verses = msg.results || [];
      } else if (verse) {
        const msg = await workerCall('directLookup', { book, chapter, verse }, 8000);
        if (msg.result) verses = [msg.result];
      }

      if (!verses.length) continue;

      lastDirectRefTime = Date.now();
      updateSermonContext(ref);
      // Update the reference context so bare "verse N" patterns can resolve
      referenceContext.update(ref.book, ref.chapter || null);

      // ── Range advance via explicit reference ────────────────────────────────
      // When a range is active and the preacher calls the next verse explicitly
      // (e.g. "verse two" or "Ezekiel forty seven two"), advance the range queue
      // instead of treating it as a brand-new detection.
      if (tryRangeAdvanceByRef(verses)) return true;

      if (isFinal) {
        // For ranges: first verse goes to viewer immediately, rest queue for operator
        if (verses.length > 1) setRangeQueue(verses);
        else clearRangeQueue();
        broadcastDetection(verses, 'direct', 1.0, 'viewer');
      } else {
        // ── Interim range advance via explicit reference ──────────────────────
        if (tryRangeAdvanceByRef(verses)) return true;

        // Interim: only show in suggestions (less confirmed), use lighter dedup
        const topKey = `${verses[0].book}|${verses[0].chapter}|${verses[0].verse}`;
        const now = Date.now();
        if (topKey === interimDetectedRef && now - interimDetectedTime < DETECT_DEDUP_MS) continue;
        interimDetectedRef  = topKey;
        interimDetectedTime = now;
        // Also feed through the main dedup so final won't re-fire
        lastDetectedRef  = topKey;
        lastDetectedTime = now;
        broadcast({
          type: 'detection',
          verses,
          method: 'direct',
          topScore: 1.0,
          target: 'viewer',   // explicit citation → go to viewer even on interim
          timestamp: now,
        });
        // Auto-send on interim too — preacher stated it explicitly
        if (settings.autoSend !== false) {
          const vKey = `${verses[0].book}|${verses[0].chapter}|${verses[0].verse}`;
          if (vKey !== lastSentRef || now - lastSentTime >= SEND_DEDUP_MS) {
            lastSentBook     = verses[0].book;
            lastSentBookTime = now;
            lastDirectSentVerse = verses[0];
            lastDirectSentTime  = now;
            sendToOutputs(verses[0]).catch(err => console.warn('[Server] sendToOutputs failed:', err.message));
          }
        }
      }
    } catch (err) {
      console.warn('[Server] Reference lookup error:', err.message);
    }
  }
  return true;
}

// ── Verbatim phrase match ─────────────────────────────────────────────────
// Run on punctuation-split clauses so the preacher's intro ("as Paul writes,")
// doesn't dilute the phrase window.
// Single batch worker call — all clauses sent at once, worker returns best result.
function buildClauseList(text, minWords) {
  const clauses = text
    .split(/[.!?,;]/)
    .map(c => c.trim())
    .filter(c => c.split(RE_SPACES).filter(Boolean).length >= minWords);
  // De-duplicate and put the full text last as a fallback
  const unique = [...new Set([...clauses, text])];
  return unique.filter(c => c.split(RE_SPACES).filter(Boolean).length >= minWords);
}

async function processVerbatim(transcript) {
  try {
    const texts = buildClauseList(transcript, 6);
    if (!texts.length) return false;
    // Single round-trip — worker iterates all clauses internally
    const msg     = await workerCall('verbatimSearchBatch', { texts, minWords: 6, limit: 3 }, 4000);
    const results = msg.results || [];
    if (!results.length) return false;
    const viewer      = results.filter(r => r.similarity >= 0.90);
    const suggestions = results.filter(r => r.similarity < 0.90);
    if (viewer.length) {
      const top        = viewer[0];
      const vKey       = `${top.book}|${top.chapter}|${top.verse}`;
      const corrected  = maybeCorrectMiscitation(top);
      if (corrected) return true;   // replaced on-air, skip the normal viewer broadcast
      const boosted = ensembleScore(vKey, 'verbatim', top.similarity, viewer);
      broadcastDetection(viewer, 'verbatim', boosted, 'viewer');
      // Feed high-confidence verbatim hits into sermon context + reading mode tracker
      if (top.similarity >= 0.92) {
        updateSermonContext({ book: top.book, chapter: top.chapter, verse: top.verse });
        trackReadingModeHit(top, top.similarity);
      }
    }
    if (suggestions.length) broadcastDetection(suggestions, 'verbatim', suggestions[0].similarity, 'suggestions');
    return true;
  } catch { return false; }
}

// If the preacher just cited scripture X but is now reading scripture Y
// verbatim with high confidence, Y is almost certainly what they meant.
// Replace on-air with Y and tag it as a correction so the operator sees what
// happened. Returns true if a correction fired (caller should skip the normal
// broadcast path).
function maybeCorrectMiscitation(topMatch) {
  if (settings.autoCorrect === false) return false;
  if (!lastDirectSentVerse) return false;
  const now = Date.now();
  if (now - lastDirectSentTime > CORRECTION_WINDOW_MS) return false;
  if (topMatch.similarity < CORRECTION_MIN_SIMILARITY) return false;

  const sameVerse = topMatch.book === lastDirectSentVerse.book
                 && topMatch.chapter === lastDirectSentVerse.chapter
                 && topMatch.verse === lastDirectSentVerse.verse;
  if (sameVerse) return false;   // verbatim agrees with what was cited — nothing to correct

  const correctedFrom = lastDirectSentVerse.reference;
  console.log(`[Correct] Replacing "${correctedFrom}" with verbatim hit "${topMatch.reference}" (${(topMatch.similarity*100).toFixed(0)}%)`);

  // Consume the window so we don't repeatedly correct from the same stale ref.
  lastDirectSentVerse = null;
  lastDirectSentTime  = 0;

  const correctedVerse = { ...topMatch, correctedFrom };
  broadcast({
    type: 'detection',
    verses: [correctedVerse],
    method: 'verbatim',
    topScore: topMatch.similarity,
    target: 'viewer',
    corrected: true,
    correctedFrom,
    timestamp: now,
  });

  // Push to outputs directly — bypass broadcastDetection's same-key dedup since
  // we specifically want to replace the mis-cited verse on ProPresenter/OBS.
  lastSentBook     = topMatch.book;
  lastSentBookTime = now;
  lastDetectedRef  = `${topMatch.book}|${topMatch.chapter}|${topMatch.verse}`;
  lastDetectedTime = now;
  sendToOutputs(topMatch).catch(err => console.warn('[Server] sendToOutputs (correction) failed:', err.message));
  return true;
}

// skipNewTranscriptCheck: true on interim path
async function runFingerprintSearch(currentSegment, skipNewTranscriptCheck = false, allowViewer = true) {
  if (!workerBasicReady) return;
  if (!skipNewTranscriptCheck && !hasNewTranscript) return;
  if (!skipNewTranscriptCheck) hasNewTranscript = false;

  // Combined window: recent non-reference buffer + current segment (last 40 words)
  const bufferText = transcriptBuffer
    .filter(t => !t.hasRef)
    .map(t => t.text)
    .join(' ');
  const combined = [bufferText, currentSegment].filter(Boolean).join(' ').trim();

  // Clause segmentation — filter out clauses with book names (reference parser owns those)
  const rawClauses = combined
    .split(/[.!?,;]/)
    .map(c => c.trim())
    .filter(c => c.split(RE_SPACES).filter(Boolean).length >= 4)
    .filter(c => {
      const ws = c.toLowerCase().split(RE_SPACES);
      return !ws.some(w => SINGLE_WORD_BOOKS.has(w.replace(/[^a-z]/g, '')));
    });

  const fallback = combined.split(RE_SPACES).slice(-40).join(' ');
  const fallbackHasBook = fallback.toLowerCase().split(RE_SPACES)
    .some(w => SINGLE_WORD_BOOKS.has(w.replace(/[^a-z]/g, '')));

  // Most recent clauses first, full window as last fallback
  const texts = [...new Set([
    ...rawClauses.reverse(),
    ...(!fallbackHasBook ? [fallback] : []),
  ])].filter(t => t.split(RE_SPACES).filter(Boolean).length >= 4);

  if (!texts.length) return;

  try {
    const contextHint     = getContextHint();
    const recentDirectRef = Date.now() - lastDirectRefTime < DIRECT_REF_SUPPRESS_MS;

    if (contextHint) {
      const top = contextHint.citations[0];
      console.log(`[Context] ${contextHint.citations.length} citation(s) — nearest: ${top.book} ${top.chapter}:${top.verse} (${Math.round(top.age / 1000)}s ago)`);
    }

    // Single round-trip — worker iterates all clauses and returns best result
    const msg        = await workerCall('fingerprintSearchBatch', { texts, limit: 5, contextHint }, 3000);
    const results    = msg.results || [];
    const confidence = msg.confidence || 'none';

    if (!results.length || confidence === 'none') return;

    if (allowViewer && (confidence === 'high' || confidence === 'medium') && !recentDirectRef) {
      const fpKey = `${results[0].book}|${results[0].chapter}|${results[0].verse}`;
      const boosted = ensembleScore(fpKey, 'fingerprint', results[0].similarity, results);
      broadcastDetection(results, 'fingerprint', boosted, 'viewer');
      // Feed high-confidence fingerprint hits into sermon context
      if (confidence === 'high' && results[0].similarity >= 0.87) {
        updateSermonContext({ book: results[0].book, chapter: results[0].chapter, verse: results[0].verse });
      }
    } else if (results.length && results[0].similarity >= 0.85) {
      // Not confident enough for the live screen, but the top result clears a high
      // bar — surface it as a single early-warning suggestion so the operator gets
      // a heads-up before verbatim confirms it.
      // Limit to top-1 only: the noise problem came from all 5 fingerprint results
      // flooding the panel with unrelated verses at similar scores.
      broadcastDetection(results.slice(0, 1), 'fingerprint', results[0].similarity, 'suggestions');
    }
    // Fingerprint below viewer threshold → drop entirely.
  // Right panel is now verbatim/phrase candidates only.
  } catch (err) {
    if (!err.message?.includes('timeout')) {
      console.warn('[Server] Fingerprint search error:', err.message);
    }
  }
}

function confidenceRank(c) {
  return c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
}

// ── Ensemble scorer ────────────────────────────────────────────────────────
// Called from processVerbatim and runFingerprintSearch before broadcasting.
// Returns boosted score if another method already detected this verse recently.
function ensembleScore(verseKey, method, score, verses) {
  if (!verseKey) return score;
  const now = Date.now();

  // Clean stale entries
  for (const [key, entry] of ensembleCache) {
    if (now - entry.time > ENSEMBLE_WINDOW_MS) ensembleCache.delete(key);
  }

  const existing = ensembleCache.get(verseKey);
  if (existing && existing.method !== method && now - existing.time <= ENSEMBLE_WINDOW_MS) {
    // Two different methods agree — boost
    const boosted = Math.min(1.0, Math.max(score, existing.score) + ENSEMBLE_BOOST);
    console.log(`[Ensemble] ${existing.method}+${method} agree on ${verseKey} → ${(boosted*100).toFixed(0)}%`);
    ensembleCache.delete(verseKey); // consume — don't triple-boost
    return boosted;
  }

  // Store for future agreement
  ensembleCache.set(verseKey, { score, method, verses, time: now });
  return score;
}

function broadcastDetection(verses, method, topScore, target) {
  const now    = Date.now();
  const topKey = verses[0] ? `${verses[0].book}|${verses[0].chapter}|${verses[0].verse}` : null;

  // ── Score gate ────────────────────────────────────────────────────────────
  // Low-confidence detections must never auto-send to the live display.
  // Demote to suggestions so the operator can still see and promote manually.
  if (target === 'viewer' && topScore < VIEWER_MIN_SCORE) {
    target = 'suggestions';
  }

  // Below the suggestions floor → drop entirely. Not useful enough to show anywhere.
  if (target === 'suggestions' && topScore < SUGGESTION_MIN_SCORE) return;

  // ── Deduplication (viewer-bound only) ─────────────────────────────────────
  // Prevents the same verse from flooding the SENT panel.
  // Exception: if the new verse is from the same book as the last sent verse
  // and arrives within SAME_BOOK_WINDOW_MS, always let it through — the preacher
  // is likely correcting or continuing in the same passage.
  if (target === 'viewer') {
    const incomingBook = verses[0]?.book || null;
    const sameBookContinuation = incomingBook && incomingBook === lastSentBook
      && now - lastSentBookTime < SAME_BOOK_WINDOW_MS
      && topKey !== lastDetectedRef; // only bypass if it's actually a different verse
    if (!sameBookContinuation) {
      if (topKey && topKey === lastDetectedRef && now - lastDetectedTime < DETECT_DEDUP_MS) return;
    }
    if (topKey) { lastDetectedRef = topKey; lastDetectedTime = now; }
  }

  broadcast({ type: 'detection', verses, method, topScore, target, timestamp: now });

  // Do NOT clear candidates on viewer send — candidates is now a permanent session log.

  if (target === 'viewer' && settings.autoSend !== false && verses[0]) {
    const vKey = `${verses[0].book}|${verses[0].chapter}|${verses[0].verse}`;
    if (vKey !== lastSentRef || now - lastSentTime >= SEND_DEDUP_MS) {
      lastSentBook     = verses[0].book;
      lastSentBookTime = now;
      if (method === 'direct') {
        lastDirectSentVerse = verses[0];
        lastDirectSentTime  = now;
      }
      sendToOutputs(verses[0]).catch(err => console.warn('[Server] sendToOutputs failed:', err.message));
    }
  }
}

// ── Output routing — sends to all enabled destinations ───────────────────
async function sendToOutputs(verse) {
  const s = loadSettings();
  const tasks = [];
  if (s.proPresenterEnabled !== false) tasks.push(sendToProPresenter(verse).catch(err => console.warn('[ProPresenter] send failed:', err.message)));
  if (s.obsEnabled && obsConnected)    tasks.push(sendToOBS(verse).catch(err => console.warn('[OBS] send failed:', err.message)));
  await Promise.all(tasks);
}

// ── ProPresenter ──────────────────────────────────────────────────────────
let _ppCachedMsg = null;
let _ppCachedUrl = null;

async function sendToProPresenter(verse) {
  const url = settings.proPresenterUrl || 'http://localhost:1025';
  const t   = settings.translation || 'KJV';

  const vKey = `${verse.book}|${verse.chapter}|${verse.verse}`;
  const now  = Date.now();
  if (vKey === lastSentRef && now - lastSentTime < SEND_DEDUP_MS) return true;
  lastSentRef  = vKey;
  lastSentTime = now;

  const refLine   = `${verse.reference} (${t})`;
  const verseText = verse.text;
  const jsonHeaders = { headers: { 'Content-Type': 'application/json' }, timeout: 3000 };

  try {
    try {
      if (!_ppCachedMsg || _ppCachedUrl !== url) {
        const messagesRes = await axios.get(`${url}/v1/messages`, { timeout: 3000 });
        const messages    = Array.isArray(messagesRes.data) ? messagesRes.data : [];
        const scriptureMsg = messages.find(m => {
          const name = (m.id?.name || m.name || '').toLowerCase();
          return /scripture|bible|verse|kairo/.test(name);
        });
        if (scriptureMsg) {
          const msgId     = scriptureMsg.id?.uuid || scriptureMsg.uuid || scriptureMsg.id;
          const detailRes = await axios.get(`${url}/v1/message/${msgId}`, { timeout: 3000 });
          const tokens    = detailRes.data.tokens || detailRes.data.message?.tokens || [];
          _ppCachedMsg = { msgId, tokens };
          _ppCachedUrl = url;
        } else {
          _ppCachedMsg = null; _ppCachedUrl = url;
        }
      }

      if (_ppCachedMsg) {
        const { msgId, tokens } = _ppCachedMsg;
        const swapOrder = settings.ppSwapTokenOrder || false;
        let triggerTokens;

        if (tokens.length >= 2) {
          let refAssigned = false, textAssigned = false;
          const nameAttempt = tokens.map(tk => {
            const tName = (tk.name || tk.id?.name || '').toLowerCase();
            let value = null;
            if (!refAssigned && /ref|book|passage|location|cite|title|header|citation/i.test(tName)) {
              value = refLine; refAssigned = true;
            } else if (!textAssigned && /text|body|content|verse|scripture|lyric|line|quote/i.test(tName)) {
              value = verseText; textAssigned = true;
            }
            return { name: tk.name || tk.id?.name, value };
          });
          if (refAssigned && textAssigned) {
            triggerTokens = nameAttempt.map(t2 => ({ name: t2.name, text: { text: t2.value } }));
          } else {
            const first  = swapOrder ? refLine : verseText;
            const second = swapOrder ? verseText : refLine;
            triggerTokens = tokens.map((tk, idx) => ({
              name: tk.name || tk.id?.name,
              text: { text: idx === 0 ? first : idx === 1 ? second : '' },
            }));
          }
        } else if (tokens.length === 1) {
          const tokenName = tokens[0].name || tokens[0].id?.name || 'Text';
          triggerTokens = [{ name: tokenName, text: { text: `${refLine}\r\n${verseText}` } }];
        } else {
          triggerTokens = [
            { name: 'Reference', text: { text: refLine } },
            { name: 'Text',      text: { text: verseText } },
          ];
        }

        await axios.post(`${url}/v1/message/${msgId}/trigger`, JSON.stringify(triggerTokens), jsonHeaders);
        broadcast({ type: 'propresenter-success', verse: { reference: verse.reference, text: verseText } });
        return true;
      }
    } catch { _ppCachedMsg = null; _ppCachedUrl = null; }

    await axios.put(`${url}/v1/stage/message`, JSON.stringify(`${refLine}\r\n\r\n${verseText}`), jsonHeaders);
    broadcast({ type: 'propresenter-success', verse: { reference: verse.reference, text: verseText } });
    return true;

  } catch (err) {
    broadcast({ type: 'propresenter-error', error: err.message });
    return false;
  }
}

async function clearProPresenter() {
  const url = settings.proPresenterUrl || 'http://localhost:1025';
  try {
    if (_ppCachedMsg?.msgId) {
      await axios.delete(`${url}/v1/message/${_ppCachedMsg.msgId}/trigger`, { timeout: 3000 });
    }
  } catch {}
}

async function testProPresenterConnection() {
  const url = settings.proPresenterUrl || 'http://localhost:1025';
  try {
    const r = await axios.get(`${url}/version`, { timeout: 3000 });
    const version = r.data?.data?.host_description || r.data?.host_description || r.data?.version || 'Connected';
    return { success: true, version };
  } catch {
    try {
      const r2 = await axios.get(`${url}/v1/version`, { timeout: 3000 });
      return { success: true, version: r2.data?.version || 'Connected' };
    } catch (e2) {
      return { success: false, error: e2.message };
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────
// Kill any stale process on PORT before binding — prevents EADDRINUSE on restart
function startListening() {
  server.listen(PORT, () => {
    console.log(`[KAIRO] Server running at http://localhost:${PORT}`);
    spawnDetectionWorker();
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[KAIRO] Port ${PORT} in use — killing stale process and retrying…`);
    const { execSync } = require('child_process');
    try {
      // macOS / Linux: find and kill whatever holds the port
      execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' });
    } catch {}
    setTimeout(() => {
      server.close();
      startListening();
    }, 500);
  } else {
    console.error('[KAIRO] Server error:', err.message);
    process.exit(1);
  }
});

startListening();

// ── Graceful shutdown ─────────────────────────────────────────────────────
// Handles: Ctrl+C (SIGINT), Tauri kill (SIGTERM), terminal close (SIGHUP)
function gracefulShutdown(signal) {
  console.log(`[KAIRO] ${signal} received — shutting down…`);
  deepgramUserStopped = true;   // stop auto-reconnect loop immediately
  if (deepgramConnection) {
    try { deepgramConnection.requestClose(); } catch {}
    deepgramConnection = null;
  }
  if (deepgramKeepAliveTimer)  { clearInterval(deepgramKeepAliveTimer);  deepgramKeepAliveTimer  = null; }
  if (deepgramSilenceWatchdog) { clearInterval(deepgramSilenceWatchdog); deepgramSilenceWatchdog = null; }
  if (detectionWorker) {
    try { detectionWorker.terminate(); } catch {}
  }
  server.close(() => {
    console.log('[KAIRO] Server closed. Goodbye.');
    process.exit(0);
  });
  // Force-exit if graceful close hangs beyond 3s
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));   // terminal window closed

// ── Parent-process watchdog ───────────────────────────────────────────────
// When CMD+Q closes the Tauri app in dev mode, the Tauri CLI (our parent)
// dies but doesn't always send SIGTERM to children. Poll every 3s and exit
// if the parent is gone — prevents orphan servers holding port 7777.
// Only activate when running under a long-lived parent (Tauri CLI / nodemon).
// Short-lived parents (nohup shell, background &) die immediately — skip those.
const _startPpid = process.ppid;
setTimeout(() => {
  try {
    process.kill(_startPpid, 0); // parent still alive after 5s → long-lived
    setInterval(() => {
      try { process.kill(_startPpid, 0); }
      catch {
        console.log('[KAIRO] Parent process gone — shutting down…');
        gracefulShutdown('PARENT_GONE');
      }
    }, 3000).unref();
  } catch {
    // Parent already dead after 5s → we were launched standalone, skip watchdog
  }
}, 5000);
