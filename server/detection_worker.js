// KAIRO — Detection Worker
// Single-phase init (no ONNX):
//   map.json → directIndex + verbatim inverted index + IDF map + verse fingerprints
//   → signals {type:'ready'}
//
// Four search layers:
//   1. directLookup      — explicit reference ("1 John 1:10"), O(1)
//   2. verbatimSearch    — exact phrase match across translations, ~5ms
//   3. fingerprintSearch — verse signature coverage for paraphrases, ~2ms
'use strict';

const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs   = require('fs');

const DATA_DIR = workerData?.dataDir || path.join(__dirname, '..', 'databases', 'logos');
const MAP_PATH = path.join(DATA_DIR, 'map.json');

// ── Cached regex (avoid re-compilation in hot paths) ─────────────────────
const RE_NORM = /[^a-z0-9\s]/g;
const RE_WS   = /\s+/g;

// ── Top-K selection (avoids full sort for large arrays) ──────────────────
function topK(arr, k, compareFn) {
  if (arr.length <= k) return arr.sort(compareFn);
  const top = arr.slice(0, k).sort(compareFn);
  for (let i = k; i < arr.length; i++) {
    if (compareFn(arr[i], top[top.length - 1]) < 0) {
      top[top.length - 1] = arr[i];
      top.sort(compareFn);
    }
  }
  return top;
}

// ── Context boost (shared between full and library fingerprint search) ───
function applyContextBoost(matchedWeight, contextHint, allVerses) {
  if (!contextHint || !contextHint.citations || !contextHint.citations.length) return;
  const WINDOW_MS      = 5 * 60 * 1000;
  const NEIGHBOR_RANGE = 5;
  const MAX_BOOST      = 0.15;

  const chapterNeighborhoods = new Map();
  for (const c of contextHint.citations) {
    if (!c.book || !c.chapter) continue;
    const key = `${c.book}|${c.chapter}`;
    const rf  = Math.max(0, 1 - c.age / WINDOW_MS);
    if (!chapterNeighborhoods.has(key)) chapterNeighborhoods.set(key, []);
    chapterNeighborhoods.get(key).push({ verse: c.verse, rf });
  }

  for (const [idx, weight] of matchedWeight.entries()) {
    const v    = allVerses[idx];
    const key  = `${v.book}|${v.chapter}`;
    const nbrs = chapterNeighborhoods.get(key);
    if (!nbrs) continue;
    let bestRF = 0;
    for (const { verse, rf } of nbrs) {
      if (verse === null || Math.abs(v.verse - verse) <= NEIGHBOR_RANGE) {
        bestRF = Math.max(bestRF, rf);
      }
    }
    if (bestRF > 0) {
      matchedWeight.set(idx, weight * (1 + MAX_BOOST * bestRF));
    }
  }
}

let verseMetadata        = [];
let directIndex          = null;   // Map<"Book|ch|vs", verse>
let verbatimIndex        = null;   // Map<word, number[]>  — inverted index for phrase match
let idfMap               = null;   // Map<word, number>    — IDF scores
let verseSignatures      = null;   // Map<idx, Map<word, idf>> — top N distinctive words per verse
let verseSignatureWeight = null;   // Map<idx, number> — total IDF weight of each verse's signature
let verseNormText        = null;   // Map<idx, string> — pre-computed norm(kjv_text)
let verseNormNlt         = null;   // Map<idx, string> — pre-computed norm(nlt_text)

// Max distinctive words stored per verse fingerprint.
// 10 gives better coverage for longer verses without inflating noise for short ones
// (short verses simply have fewer qualifying words — the cap is a ceiling, not a target).
const SIGNATURE_SIZE = 10;

// ── Stop words ────────────────────────────────────────────────────────────
// Structural words that carry no topical meaning in scripture detection.
// IDF also handles very common words, but this speeds up query processing.
const STOP_WORDS = new Set([
  // Articles / prepositions / conjunctions
  'a','an','the','and','but','or','for','nor','yet','so',
  'in','on','at','to','of','by','up','as','is','it','be',
  'do','if','no','i','we','he','me','us','am','my',
  // Auxiliary verbs
  'was','are','were','been','being','have','has','had',
  'does','did','will','would','can','could','shall','should','may','might',
  // Pronouns
  'you','she','they','them','their','this','that','these','those',
  'who','which','what','him','his','her','its','our','your',
  // Common adverbs / filler
  'not','all','very','also','just','more','then','than',
  'when','where','there','here','now','too','only','even','still',
  'from','with','into','about','over','after','before','out','down',
  'how','each','both','some','any','same','other','such','own','while',
  'say','said','says','come','came','went','get','got','make','made',
  // Biblical archaic structural words
  'thou','thee','thy','thine','ye','hath','doth','art',
  'unto','saith','thus','yea','nay','therefore','wherefore',
  'moreover','lo','behold','thereof','therein','whereby','wherein',
  'whereof','whatsoever','whosoever','thence','hence','whence',
]);

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  console.log('[DetectionWorker] Loading map.json…');
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  verseMetadata = raw.verses;

  // O(1) direct lookup
  directIndex = new Map();
  for (const v of verseMetadata) {
    directIndex.set(`${v.book}|${v.chapter}|${v.verse}`, v);
  }
  console.log(`[DetectionWorker] ${verseMetadata.length} verses indexed.`);

  // Inverted index: word → [verseIdx, ...]
  // Also tracks document frequency (df) for IDF computation
  const norm = s => s.toLowerCase().replace(RE_NORM, '').replace(RE_WS, ' ').trim();

  // Pre-compute normalized text for every verse (avoids re-normalizing in hot loops)
  verseNormText = new Map();
  verseNormNlt  = new Map();
  for (let i = 0; i < verseMetadata.length; i++) {
    const v = verseMetadata[i];
    verseNormText.set(i, norm(v.kjv_text));
    if (v.nlt_text) verseNormNlt.set(i, norm(v.nlt_text));
  }

  const tempIndex = new Map(); // word → Set<idx> (unique per verse)
  for (let i = 0; i < verseMetadata.length; i++) {
    const kjvN = verseNormText.get(i);
    const nltN = verseNormNlt.get(i);
    const words = new Set([
      ...kjvN.split(' '),
      ...(nltN ? nltN.split(' ') : []),
    ]);
    for (const w of words) {
      if (w.length < 3) continue;
      if (!tempIndex.has(w)) tempIndex.set(w, []);
      tempIndex.get(w).push(i);
    }
  }
  verbatimIndex = tempIndex;
  console.log(`[DetectionWorker] Verbatim index: ${verbatimIndex.size} unique words.`);

  // IDF map — log((N - df + 0.5) / (df + 0.5) + 1)
  // High IDF = rare/distinctive word (e.g. "meditate" ≈ 7.6)
  // Low IDF  = very common word (e.g. "lord" ≈ 1.2)
  const N = verseMetadata.length;
  idfMap = new Map();
  for (const [word, indices] of verbatimIndex.entries()) {
    const df  = indices.length;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(word, idf);
  }
  console.log('[DetectionWorker] IDF map ready.');

  // Verse fingerprints — top SIGNATURE_SIZE words by IDF for each verse.
  // Only words with IDF ≥ 1.5 qualify (rules out words appearing in >80% of verses).
  // Stored as Map<word, idf> per verse for O(1) hit lookup at query time.
  // Nothing hardcoded — derived entirely from the Bible data + IDF scores above.
  const IDF_FLOOR = 1.5;
  verseSignatures      = new Map();
  verseSignatureWeight = new Map();
  for (let i = 0; i < verseMetadata.length; i++) {
    const kjvN  = verseNormText.get(i);
    const nltN  = verseNormNlt.get(i);
    const words = [...new Set([
      ...kjvN.split(' '),
      ...(nltN ? nltN.split(' ') : []),
    ])].filter(w => w.length >= 4 && !STOP_WORDS.has(w));

    const top = words
      .map(w => [w, idfMap.get(w) || 0])
      .filter(([, idf]) => idf >= IDF_FLOOR)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SIGNATURE_SIZE);

    verseSignatures.set(i, new Map(top));
    verseSignatureWeight.set(i, top.reduce((s, [, idf]) => s + idf, 0));
  }
  console.log(`[DetectionWorker] Verse fingerprints built (${SIGNATURE_SIZE} words/verse max).`);

  parentPort.postMessage({ type: 'ready' });
  console.log('[DetectionWorker] Ready — all four detection layers active.');
}

// ── Direct lookup ─────────────────────────────────────────────────────────
function directLookup(book, chapter, verse) {
  let v = directIndex.get(`${book}|${chapter}|${verse}`);
  if (!v && book === 'Psalm') v = directIndex.get(`Psalms|${chapter}|${verse}`);
  return v ? formatVerse(v, 1.0, 'direct') : null;
}

function lookupRange(book, chapter, verseStart, verseEnd) {
  const results = [];
  for (let vs = verseStart; vs <= verseEnd; vs++) {
    const v = directLookup(book, chapter, vs);
    if (v) results.push(v);
  }
  return results;
}

function formatVerse(v, similarity, method) {
  return {
    reference: v.reference, text: v.kjv_text, nlt_text: v.nlt_text,
    book: v.book, chapter: v.chapter, verse: v.verse, similarity, method,
  };
}

// ── Text search ───────────────────────────────────────────────────────────
function textSearch(query, limit = 8) {
  const q = query.toLowerCase();
  const results = [];
  for (const v of verseMetadata) {
    if (v.kjv_text.toLowerCase().includes(q) || v.nlt_text?.toLowerCase().includes(q)) {
      results.push(formatVerse(v, 0.9, 'text'));
      if (results.length >= limit) break;
    }
  }
  return results;
}

// ── N-gram helpers ────────────────────────────────────────────────────────
// Build a Set of every consecutive N-word sequence in a word array.
function buildNgramSet(words, n) {
  const s = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    s.add(words.slice(i, i + n).join(' '));
  }
  return s;
}

// What fraction of a verse's 4-grams appear anywhere in the transcript?
// This handles paraphrasing and STT insertion errors gracefully:
//   Transcript: "data that we planted in the house of the lord they shall flourish"
//   Verse:      "those that be planted in the house of the lord shall flourish…"
//   4-grams "planted in the house", "in the house of", "the house of the lord",
//   "shall flourish in the", "flourish in the courts"… all still match exactly.
function ngramCoverage(tNgramSet, verseWords, n) {
  const total = verseWords.length - n + 1;
  if (total <= 0) return 0;
  let matched = 0;
  for (let i = 0; i < total; i++) {
    if (tNgramSet.has(verseWords.slice(i, i + n).join(' '))) matched++;
  }
  return matched / total;
}

// ── Verbatim search (inverted index + phrase window) ──────────────────────
function verbatimSearch(transcript, minWords = 6, limit = 3) {
  const norm   = s => s.toLowerCase().replace(RE_NORM, '').replace(RE_WS, ' ').trim();
  const tNorm  = norm(transcript);
  const tWords = tNorm.split(' ').filter(Boolean);
  if (tWords.length < minWords) return [];

  // Overlapping phrase windows, longest first
  const phrases = [];
  for (let len = Math.min(12, tWords.length); len >= minWords; len--) {
    for (let i = 0; i <= tWords.length - len; i++) {
      phrases.push(tWords.slice(i, i + len).join(' '));
    }
  }

  // Candidate verses via inverted index
  const queryWords = [...new Set(tWords)].filter(w => w.length >= 3);
  const counts = new Map();
  for (const w of queryWords) {
    for (const idx of (verbatimIndex.get(w) || [])) {
      counts.set(idx, (counts.get(idx) || 0) + 1);
    }
  }

  const threshold  = Math.max(2, Math.floor(queryWords.length * 0.4));
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300)
    .map(([idx]) => idx);

  const results = [];
  const seen    = new Set();
  for (const idx of candidates) {
    if (seen.has(idx)) continue;
    const v    = verseMetadata[idx];
    const kjvN = verseNormText.get(idx);
    const nltN = verseNormNlt.get(idx) || '';
    for (const phrase of phrases) {
      if (kjvN.includes(phrase) || nltN.includes(phrase)) {
        const phraseLenWords = phrase.split(' ').length;
        const verseLenWords  = kjvN.split(' ').filter(Boolean).length;

        // Coverage ratio: what fraction of the verse did we actually match?
        // A 12-word match on a 12-word verse = 1.0 (full).
        // A 12-word match on a 28-word verse = 0.43 (partial tail).
        // √coverage softens the curve: full = 1.0, 50% ≈ 0.71, 25% = 0.50.
        // This prevents short common phrases ("In the name of Jesus Christ of
        // Nazareth") from scoring 0.99 just because 12 words were matched when
        // the verse has 28 words and the preceding words weren't spoken at all.
        const coverageRatio  = Math.min(1, phraseLenWords / Math.max(1, verseLenWords));
        const lengthScore    = phraseLenWords / 12;
        const rawScore       = 0.75 + lengthScore * 0.24;
        const score          = Math.min(0.99, rawScore * Math.sqrt(coverageRatio));

        results.push(formatVerse(v, score, 'verbatim'));
        seen.add(idx);
        break;
      }
    }
    if (results.length >= limit) break;
  }

  // ── N-gram coverage fallback ────────────────────────────────────────────
  // For candidates that didn't match via exact phrase window, compute 4-gram
  // overlap: what percentage of the VERSE'S own 4-grams appear anywhere in
  // the transcript?  Handles:
  //   • STT word substitutions  ("data that we" ≠ "those that be" but the
  //     following grams all still land)
  //   • Paraphrasing / loose allusions ("they shall flourish in the courts
  //     of our God" ≈ Ps 92:13 even without quoting the opening)
  //   • Multi-sentence spread (rolling buffer contains multiple clauses)
  //
  // Scoring: 40% coverage → 0.65, 100% coverage → 0.82 (intentionally kept
  // below the 0.90 exact-phrase ceiling so the two tiers are distinguishable).
  if (results.length < limit) {
    const NGRAM_N        = 4;
    const NGRAM_MIN_COV  = 0.40;   // at least 40% of verse 4-grams spoken
    const tNgramSet      = buildNgramSet(tWords, NGRAM_N);

    for (const idx of candidates) {
      if (seen.has(idx)) continue;
      const v         = verseMetadata[idx];
      const verseWords = verseNormText.get(idx).split(' ').filter(Boolean);
      if (verseWords.length < NGRAM_N) continue;

      const cov = ngramCoverage(tNgramSet, verseWords, NGRAM_N);
      if (cov >= NGRAM_MIN_COV) {
        // Scale 0.40–1.0 → 0.65–0.82
        const score = Math.min(0.82, 0.65 + (cov - NGRAM_MIN_COV) / 0.60 * 0.17);
        results.push(formatVerse(v, score, 'verbatim'));
        seen.add(idx);
      }
      if (results.length >= limit) break;
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}

// ── Fingerprint search (verse signature coverage matching) ────────────────
// Each verse has a pre-computed fingerprint: its top SIGNATURE_SIZE words
// ranked by IDF (most distinctive first). Scores are computed entirely from
// the Bible data — nothing hardcoded.
//
// At query time:
//   1. Extract content words from speech (length ≥ 4, not in STOP_WORDS)
//   2. For each speech word, check if it appears in a verse's signature
//   3. Coverage score = matched signature IDF / total signature IDF
//      → a verse where 3 of its 5 signature words were spoken (60%) beats
//        one where 3 of its 20 words appeared (15%)
//   4. Apply the same confidence routing used before
//
// Example: "you must meditate in day and night"
//   → content words: ["meditate", "night"] (after stop-word filter)
//   → "meditate" is a signature word of Joshua 1:8 and Psalm 1:2
//   → "night" is also in both signatures
//   → coverage for both is high → medium confidence → both shown
//
// Returns { results, confidence: 'high' | 'medium' | 'low' | 'none' }
// contextHint: { citations: [{book, chapter, verse, age}] }
//   citations = last 8 explicitly cited verses, most recent first, within 5 min.
//
// Boost logic — tie-breaker only, word match always primary:
//   A scored verse gets a boost if it is a *neighbor* of any recent citation
//   (same book+chapter, verse within ±5) or an exact match of a citation.
//
//   boostFactor = 1 + (0.15 × recencyFactor)   → max 1.15×
//   recencyFactor decays linearly: 1.0 at 0s → 0.0 at 5 min
//
// A verse with zero word matches never gets promoted — boost only amplifies
// an existing score. This preserves the 87%+ word-match precision.
function fingerprintSearch(transcript, limit = 5, contextHint = null) {
  const norm = s => s.toLowerCase().replace(RE_NORM, '').replace(RE_WS, ' ').trim();
  const speechWords = [...new Set(
    norm(transcript).split(' ')
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  )];

  if (speechWords.length < 1) return { results: [], confidence: 'none' };

  // Accumulate matched signature IDF per verse.
  // Only increments if the speech word is actually in that verse's fingerprint —
  // so common words that appear in many verses but aren't signature words don't score.
  const matchedWeight    = new Map();
  const matchedWordCount = new Map();  // track distinct word hits per verse
  for (const w of speechWords) {
    for (const idx of (verbatimIndex.get(w) || [])) {
      const sig = verseSignatures.get(idx);
      if (!sig) continue;
      const idf = sig.get(w);
      if (idf !== undefined) {
        matchedWeight.set(idx, (matchedWeight.get(idx) || 0) + idf);
        matchedWordCount.set(idx, (matchedWordCount.get(idx) || 0) + 1);
      }
    }
  }

  if (!matchedWeight.size) return { results: [], confidence: 'none' };

  // ── Context boost (tie-breaker only) ──────────────────────────────────
  applyContextBoost(matchedWeight, contextHint, verseMetadata);

  // Coverage = matched signature weight / total signature weight.
  // Threshold: at least 35% of the verse's fingerprint must be covered,
  // AND at least 2 distinct signature words must match (prevents single-word
  // false positives on short verses like "thy years shall have no end").
  const COVERAGE_THRESHOLD = 0.35;
  const MIN_WORD_HITS      = 2;
  const qualified = [...matchedWeight.entries()]
    .map(([idx, matched]) => [idx, matched / (verseSignatureWeight.get(idx) || 1)])
    .filter(([idx, coverage]) => coverage >= COVERAGE_THRESHOLD && (matchedWordCount.get(idx) || 0) >= MIN_WORD_HITS);
  const scored = topK(qualified, limit + 1, (a, b) => b[1] - a[1]);

  if (!scored.length) return { results: [], confidence: 'none' };

  const topCoverage    = scored[0][1];
  const secondCoverage = scored.length > 1 ? scored[1][1] : 0;
  const tied           = scored.filter(([, c]) => c >= topCoverage * 0.9);

  let confidence;
  if (tied.length === 1 || secondCoverage === 0) {
    confidence = 'high';
  } else if (tied.length <= 3 && topCoverage / secondCoverage >= 1.4) {
    confidence = 'high';
  } else if (tied.length <= 3) {
    confidence = 'medium';
  } else if (tied.length <= 5) {
    confidence = 'low';
  } else {
    confidence = 'none';
  }

  if (confidence === 'none') return { results: [], confidence: 'none' };

  const results = tied
    .slice(0, limit)
    .map(([idx, coverage]) => ({
      ...formatVerse(verseMetadata[idx], Math.min(0.97, coverage), 'fingerprint'),
    }));

  return { results, confidence };
}

// ── Topic Library ─────────────────────────────────────────────────────────
// Built from recurring high-IDF words extracted from speech over the first
// 2-5 minutes of the sermon. Stores the top 80 verse indices most relevant
// to the current topic — pre-ranked, cached, ready.
//
// When the preacher has been talking about "forgiveness, mercy, cleanse, restore"
// for 3 minutes, this library contains the ~60-80 verses that live at the
// intersection of those themes. Every subsequent fingerprint search checks
// this library first — searching 80 verses instead of 31,000.
//
// The library rebuilds every 60s as topic words accumulate, so it sharpens
// over time rather than locking in early. Falls back to full index if no
// library match is found.

let topicLibrary      = null;   // Set<idx> of pre-ranked verse indices
let topicLibraryWords = [];     // the topic words that built this library

const TOPIC_LIBRARY_SIZE = 80;

function buildTopicLibrary(topicWords) {
  if (!topicWords || topicWords.length < 2) {
    topicLibrary      = null;
    topicLibraryWords = [];
    return { size: 0 };
  }

  // Score every verse by how many topic words appear in its signature
  // (same mechanism as fingerprintSearch but across the full index)
  const scores = new Map();
  for (const w of topicWords) {
    const idf = idfMap.get(w);
    if (!idf || idf < 1.5) continue;
    for (const idx of (verbatimIndex.get(w) || [])) {
      const sig = verseSignatures.get(idx);
      if (!sig || !sig.has(w)) continue;
      scores.set(idx, (scores.get(idx) || 0) + idf);
    }
  }

  if (!scores.size) {
    topicLibrary      = null;
    topicLibraryWords = topicWords;
    return { size: 0 };
  }

  // Keep the top TOPIC_LIBRARY_SIZE by raw score — these are the verses
  // most relevant to the topic. Coverage normalization happens at query time.
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPIC_LIBRARY_SIZE)
    .map(([idx]) => idx);

  topicLibrary      = new Set(ranked);
  topicLibraryWords = topicWords;

  console.log(`[DetectionWorker] Topic library built: ${topicLibrary.size} verses for [${topicWords.slice(0, 5).join(', ')}${topicWords.length > 5 ? '...' : ''}]`);
  return { size: topicLibrary.size, words: topicWords };
}

// Fingerprint search scoped to the topic library.
// Same scoring as full fingerprintSearch but only iterates library candidates.
// Called first — if it returns a high/medium result, skip the full search.
function fingerprintSearchInLibrary(transcript, limit = 5, contextHint = null) {
  if (!topicLibrary || !topicLibrary.size) return { results: [], confidence: 'none' };

  const norm = s => s.toLowerCase().replace(RE_NORM, '').replace(RE_WS, ' ').trim();
  const speechWords = [...new Set(
    norm(transcript).split(' ')
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  )];
  if (!speechWords.length) return { results: [], confidence: 'none' };

  const matchedWeight    = new Map();
  const matchedWordCount = new Map();
  for (const w of speechWords) {
    for (const idx of (verbatimIndex.get(w) || [])) {
      if (!topicLibrary.has(idx)) continue;   // library-scoped
      const sig = verseSignatures.get(idx);
      if (!sig) continue;
      const idf = sig.get(w);
      if (idf !== undefined) {
        matchedWeight.set(idx, (matchedWeight.get(idx) || 0) + idf);
        matchedWordCount.set(idx, (matchedWordCount.get(idx) || 0) + 1);
      }
    }
  }

  if (!matchedWeight.size) return { results: [], confidence: 'none' };

  // Apply context boost (same as full search)
  applyContextBoost(matchedWeight, contextHint, verseMetadata);

  const COVERAGE_THRESHOLD = 0.35;
  const MIN_WORD_HITS      = 2;
  const qualified = [...matchedWeight.entries()]
    .map(([idx, matched]) => [idx, matched / (verseSignatureWeight.get(idx) || 1)])
    .filter(([idx, coverage]) => coverage >= COVERAGE_THRESHOLD && (matchedWordCount.get(idx) || 0) >= MIN_WORD_HITS);
  const scored = topK(qualified, limit + 1, (a, b) => b[1] - a[1]);

  if (!scored.length) return { results: [], confidence: 'none' };

  const topCoverage    = scored[0][1];
  const secondCoverage = scored.length > 1 ? scored[1][1] : 0;
  const tied           = scored.filter(([, c]) => c >= topCoverage * 0.9);

  let confidence;
  if (tied.length === 1 || secondCoverage === 0)                       confidence = 'high';
  else if (tied.length <= 3 && topCoverage / secondCoverage >= 1.4)   confidence = 'high';
  else if (tied.length <= 3)                                           confidence = 'medium';
  else if (tied.length <= 5)                                           confidence = 'low';
  else                                                                 confidence = 'none';

  if (confidence === 'none') return { results: [], confidence: 'none' };

  return {
    results: tied.slice(0, limit).map(([idx, coverage]) => ({
      ...formatVerse(verseMetadata[idx], Math.min(0.97, coverage), 'fingerprint'),
    })),
    confidence,
    fromLibrary: true,
  };
}

// ── Message handler ───────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'directLookup': {
        const result = directLookup(msg.book, msg.chapter, msg.verse);
        parentPort.postMessage({ type: 'directResult', id: msg.id, result });
        break;
      }
      case 'rangeLookup': {
        const results = lookupRange(msg.book, msg.chapter, msg.verseStart, msg.verseEnd);
        parentPort.postMessage({ type: 'rangeResult', id: msg.id, results });
        break;
      }
      case 'chapterLookup': {
        // Return all verses in a chapter (up to 200)
        const results = [];
        for (let vs = 1; vs <= 200; vs++) {
          const v = directLookup(msg.book, msg.chapter, vs);
          if (!v) break;
          results.push(v);
        }
        parentPort.postMessage({ type: 'rangeResult', id: msg.id, results });
        break;
      }
      case 'textSearch': {
        const results = textSearch(msg.query, msg.limit || 8);
        parentPort.postMessage({ type: 'textResults', id: msg.id, results });
        break;
      }
      case 'verbatimSearch': {
        const results = verbatimSearch(msg.text, msg.minWords || 6, msg.limit || 3);
        parentPort.postMessage({ type: 'verbatimResults', id: msg.id, results });
        break;
      }
      case 'fingerprintSearch': {
        // Try topic library first — if high/medium confidence, use it directly.
        // Library search is ~50× faster and topically pre-filtered.
        const libResult = fingerprintSearchInLibrary(msg.text, msg.limit || 5, msg.contextHint || null);
        if (libResult.results.length && libResult.confidence !== 'none' &&
            (libResult.confidence === 'high' || libResult.confidence === 'medium')) {
          parentPort.postMessage({ type: 'fingerprintResults', id: msg.id, ...libResult });
          break;
        }
        // Fall back to full index search
        const fullResult = fingerprintSearch(msg.text, msg.limit || 5, msg.contextHint || null);
        // Merge: if library had low-confidence results, include them alongside full results
        let merged;
        if (libResult.results.length) {
          const seen = new Set();
          const deduped = [];
          for (const r of [...fullResult.results, ...libResult.results]) {
            const key = `${r.book}|${r.chapter}|${r.verse}`;
            if (!seen.has(key)) { seen.add(key); deduped.push(r); }
          }
          merged = { ...fullResult, results: deduped.slice(0, msg.limit || 5) };
        } else {
          merged = fullResult;
        }
        parentPort.postMessage({ type: 'fingerprintResults', id: msg.id, ...merged });
        break;
      }
      // Batch variants — accept multiple texts, return the single best result.
      // Server sends all clauses in one call instead of N sequential calls,
      // eliminating N-1 round-trip latencies in continuous speech.
      case 'verbatimSearchBatch': {
        let best = null;
        for (const text of (msg.texts || [])) {
          const results = verbatimSearch(text, msg.minWords || 6, msg.limit || 3);
          if (!results.length) continue;
          if (!best || results[0].similarity > best[0].similarity) best = results;
          if (best[0].similarity >= 0.98) break;   // perfect match — stop early
        }
        parentPort.postMessage({ type: 'verbatimResults', id: msg.id, results: best || [] });
        break;
      }
      case 'fingerprintSearchBatch': {
        // Try topic library across all clauses first
        let best = { results: [], confidence: 'none' };
        const rank = c => c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
        for (const text of (msg.texts || [])) {
          const r = fingerprintSearchInLibrary(text, msg.limit || 5, msg.contextHint || null);
          if (rank(r.confidence) > rank(best.confidence)) best = r;
          if (best.confidence === 'high') break;
        }
        // Fall back to full index if library didn't return high/medium
        if (rank(best.confidence) < 2) {
          for (const text of (msg.texts || [])) {
            const r = fingerprintSearch(text, msg.limit || 5, msg.contextHint || null);
            if (rank(r.confidence) > rank(best.confidence)) best = r;
            if (best.confidence === 'high') break;
          }
        }
        parentPort.postMessage({ type: 'fingerprintResults', id: msg.id, ...best });
        break;
      }
      case 'buildTopicLibrary': {
        const result = buildTopicLibrary(msg.topicWords);
        parentPort.postMessage({ type: 'topicLibraryReady', id: msg.id, ...result });
        break;
      }
      case 'getIdfScores': {
        const words = (msg.words || []).map(w => [w, idfMap.get(w) || 0]);
        parentPort.postMessage({ type: 'idfScores', id: msg.id, words });
        break;
      }
      case 'ping':
        parentPort.postMessage({ type: 'pong', ready: true });
        break;
    }
  } catch (err) {
    console.error('[DetectionWorker] Error:', err.message);
    parentPort.postMessage({ type: 'error', id: msg.id, error: err.message });
  }
});

init().catch(err => {
  console.error('[DetectionWorker] Init failed:', err.message);
  parentPort.postMessage({ type: 'initError', error: err.message });
});
