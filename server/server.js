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

const { parseSpokenReference, parseAllSpokenReferences, SINGLE_WORD_BOOKS } = require('./reference_parser');

// ── Config ────────────────────────────────────────────────────────────────
const PORT     = 7777;
const DATA_DIR = path.join(__dirname, '..', 'databases', 'logos');

// ── Cached regex patterns (hot-path) ─────────────────────────────────────
const RE_NONALPHA   = /[^a-z\s]/g;
const RE_WHITESPACE = /\s+/g;
const RE_SPACES     = /\s+/;

// ── Settings ──────────────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, '..', 'databases', 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}
let settings = loadSettings();

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
}

function workerCall(type, payload, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!detectionWorker) return reject(new Error('Worker not started'));
    const id = ++workerMsgId;
    const timeout = setTimeout(() => {
      pendingCallbacks.delete(id);
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
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'src')));

// ── WebSocket ─────────────────────────────────────────────────────────────
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  // Send current worker status on connect
  ws.send(JSON.stringify({ type: 'worker-status', ready: workerBasicReady }));

  // Forward binary audio frames to Deepgram
  ws.on('message', (data, isBinary) => {
    if (isBinary && deepgramConnection) {
      try { deepgramConnection.send(data); } catch {}
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

// Suppress fingerprint search from routing to viewer for N ms after a direct reference
let lastDirectRefTime = 0;
const DIRECT_REF_SUPPRESS_MS = 12000;

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
  await sendToProPresenter(next);
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

  // How long this verse should take at the current pace, plus 15% grace
  const estimatedMs = (verseWordCount / wps) * 1000 * 1.15;
  // Never advance in under 3 seconds regardless of verse length
  const waitMs      = Math.max(3000, estimatedMs);
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

app.post('/api/start-listening', async (req, res) => {
  res.json(await startDeepgram(req.body || {}));
});

app.post('/api/stop-listening', async (_, res) => {
  await stopDeepgram();
  res.json({ ok: true });
});

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

          const transcript = alt.transcript;
          const isFinal    = data.is_final;
          const confidence = alt.confidence || 0;

          broadcast({ type: 'transcript', text: transcript, isFinal, confidence });

          // ── Interim transcripts ───────────────────────────────────────
          // Reference parser fires on interim for < 2s explicit citations.
          // Fingerprint also fires on longer interim segments so paraphrase
          // detection doesn't wait for the endpoint (300-1200ms delay).
          if (!isFinal) {
            if (workerBasicReady) {
              const foundRef = await processForReferences(transcript, false);
              if (!foundRef) {
                const interimWords = transcript.split(RE_SPACES).filter(Boolean).length;
                const now = Date.now();

                // Range timing check on interim path too — so the advance
                // fires as soon as the estimated time elapses, not waiting
                // for the next final segment to arrive.
                if (rangeQueue.length) checkRangeAutoAdvance();

                // Run verbatim/n-gram search on interim once enough words have
                // accumulated. This fires detection BEFORE Deepgram's endpoint
                // silence (300-1200ms), eliminating the "greyed-out waiting"
                // delay. Throttled to once per 800ms so the worker isn't hammered.
                if (interimWords >= 6 && now - lastInterimVerbatim > INTERIM_VERBATIM_MS) {
                  lastInterimVerbatim = now;
                  processVerbatim(transcript).catch(() => {});
                }

                // Fingerprint on longer interim segments for paraphrase detection
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

          // Feed speech into topic accumulator — builds the active verse library
          // passively in the background as the sermon progresses
          accumulateTopicWords(transcript);
          maybeRebuildTopicLibrary();

          // If a verse range is active, check if preacher has moved to the next verse
          if (rangeQueue.length) checkRangeAutoAdvance();

          // Path 1: direct reference (may be deduped if interim already fired)
          const foundRef = await processForReferences(transcript, true);

          if (transcriptBuffer.length) {
            transcriptBuffer[transcriptBuffer.length - 1].hasRef = !!foundRef;
          }

          // Always run fingerprint/verbatim even when a reference was found —
          // the reference might be wrong (STT garble). Route results to
          // suggestions only (not viewer) so the operator sees the real verse.
          if (workerBasicReady) {
            const canFingerprint = now - lastFingerprintSearch > FINGERPRINT_INTERVAL_MS;

            if (canFingerprint) {
              lastFingerprintSearch = now;
              await Promise.all([
                processVerbatim(transcript),
                runFingerprintSearch(transcript, !foundRef), // viewer only if no ref found
              ]);
            } else {
              // Fingerprint is throttled — still run verbatim alone
              await processVerbatim(transcript);
            }
          }
        } catch (err) {
          console.error('[Deepgram] Transcript handler error:', err.message);
        }
      });

      deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
        clearInterval(deepgramKeepAliveTimer);
        clearInterval(deepgramSilenceWatchdog);
        const msg = err?.message || err?.reason || err?.description
          || (typeof err === 'string' ? err : JSON.stringify(err));
        console.error('[Deepgram] Error:', msg);
        connectionState = 'error';
        broadcast({ type: 'connection-state', state: 'error', error: msg });
        resolve({ error: msg });
      });

      deepgramConnection.on(LiveTranscriptionEvents.Close, (code) => {
        // Closed before Open fired = connection rejected
        if (connectionState === 'connecting') {
          const msg = `Deepgram closed before connecting (code ${code})`;
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
          console.log(`[Deepgram] Connection closed (code ${code}) — reconnecting in 1.5s…`);
          broadcast({ type: 'connection-state', state: 'reconnecting' });
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

// ── Reference detection ───────────────────────────────────────────────────
// isFinal: true → normal flow (can auto-send to PP)
// isFinal: false → from interim → route to suggestions, lighter dedup
async function processForReferences(transcript, isFinal) {
  if (!workerBasicReady) return false;
  const refs = parseAllSpokenReferences(transcript, inBibleMode);
  if (!refs.length) return false;

  for (const ref of refs) {
    const { book, chapter, verse, verseStart, verseEnd, ranges } = ref;
    if (!verse && !verseStart && !ranges) continue; // need at least a verse number

    inBibleMode = true;
    clearTimeout(bibleModeClearTimer);
    bibleModeClearTimer = setTimeout(() => { inBibleMode = false; }, 30000);

    try {
      let verses = [];

      if (ranges && ranges.length > 1) {
        for (const r of ranges) {
          const msg = await workerCall('rangeLookup', { book, chapter, verseStart: r.verseStart, verseEnd: r.verseEnd }, 4000);
          verses.push(...(msg.results || []));
        }
      } else if (verseStart && verseEnd && verseEnd !== verseStart) {
        const msg = await workerCall('rangeLookup', { book, chapter, verseStart, verseEnd }, 4000);
        verses = msg.results || [];
      } else if (verse) {
        const msg = await workerCall('directLookup', { book, chapter, verse }, 4000);
        if (msg.result) verses = [msg.result];
      }

      if (!verses.length) continue;

      lastDirectRefTime = Date.now();
      updateSermonContext(ref);

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
            sendToProPresenter(verses[0]).catch(() => {});
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
    if (viewer.length)      broadcastDetection(viewer,      'verbatim', viewer[0].similarity,      'viewer');
    if (suggestions.length) broadcastDetection(suggestions, 'verbatim', suggestions[0].similarity, 'suggestions');
    return true;
  } catch { return false; }
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
      broadcastDetection(results, 'fingerprint', results[0].similarity, 'viewer');
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
      sendToProPresenter(verses[0]).catch(() => {});
    }
  }
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
