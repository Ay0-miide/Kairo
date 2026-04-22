// KAIRO v2 — Frontend App
// Communicates with the Node.js server via WebSocket (live events)
// and fetch (commands). No Electron IPC.
'use strict';

const SERVER = 'http://localhost:7777';
const WS_URL = 'ws://localhost:7777';

// ── Helpers ────────────────────────────────────────────────────────────────
// Strip KJV annotation markers: {note} {word: alt} [Header text]
function cleanVerseText(text) {
  return (text || '')
    .replace(/\[[^\]]*\]/g, '')   // remove [A Psalm of David…] headers
    .replace(/\{[^}]*\}/g, '')    // remove {art} {thirsty: Heb. weary} etc.
    .replace(/\s{2,}/g, ' ')      // collapse double spaces left behind
    .trim();
}

// "Matthew 17:21" → "MT·17"   |   "1 Chronicles 6:18" → "1CH·6"   |   "Song of Solomon 2:1" → "SO·2"
// The badge pill has a fixed width; returning the full book name overflows it.
function refToBadgeAbbr(reference) {
  const parts = (reference || '').split(' ');
  if (!parts.length) return '??';
  const isNumbered = /^[123]$/.test(parts[0] || '');
  const bookWord   = parts[isNumbered ? 1 : 0] || '';
  const bookAbbr   = (isNumbered ? parts[0] : '') + bookWord.slice(0, 2).toUpperCase();
  // Chapter always lives in the last whitespace-separated token (C:V form).
  const chapNum    = (parts[parts.length - 1] || '').split(':')[0];
  return bookAbbr + (chapNum ? '·' + chapNum : '');
}

// ── State ──────────────────────────────────────────────────────────────────
let ws             = null;
let wsReconnectTimer = null;
let isListening    = false;
let mediaStream    = null;
let audioContext   = null;
let audioProcessor = null;
let workerReady    = false;
let settings       = {};
let elapsedInterval = null;
let startTime      = null;
let wordCount      = 0;
let verseCount     = 0;
let sessionVerses  = [];
let allConfidences = [];
let rangeRefs      = new Set(); // references belonging to the active verse range

// ── DOM ────────────────────────────────────────────────────────────────────
const listenBtn          = document.getElementById('listen-btn');
const listenText         = listenBtn?.querySelector('.listen-text');
const micDisplay         = document.getElementById('mic-display');
const elapsedTimeEl      = document.getElementById('elapsed-time');
const transcriptContent  = document.getElementById('transcript-content');
const proPresenterStatus = document.getElementById('propresenter-status');
const propresenterDot    = document.getElementById('propresenter-dot');
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const closeSettingsBtn   = document.getElementById('close-settings');
const cancelSettingsBtn  = document.getElementById('cancel-settings');
const saveSettingsBtn    = document.getElementById('save-settings');
const testPPBtn          = document.getElementById('test-propresenter-btn');
const autoSendCheckbox   = document.getElementById('auto-send-checkbox');
const autoSendSettings   = document.getElementById('auto-send-settings');
const toastContainer     = document.getElementById('toast-container');
const workerStatusEl     = document.getElementById('worker-status');
const verseCountEl       = document.getElementById('verse-count');
const wordCountEl        = document.getElementById('word-count');
const avgConfidenceEl    = document.getElementById('avg-confidence');
const elapsedMetricEl    = document.getElementById('elapsed-time-metric');
const exportBtn          = document.getElementById('export-btn');
const clearLockedBtn     = document.getElementById('clear-locked-btn');
const clearSuggestionsBtn = document.getElementById('clear-suggestions-btn');
const clearTranscriptBtn = document.getElementById('clear-transcript');
const previewVerseText   = document.getElementById('preview-verse-text');
const previewVerseRef    = document.getElementById('preview-verse-ref');
const currentDisplayCard = document.getElementById('current-display-card');
const queueList          = document.getElementById('queue-list');
const suggestionCount    = document.getElementById('suggestion-count');

// Search
const scriptureSearchInput = document.getElementById('scripture-search-input');
const scriptureSearchBtn   = document.getElementById('scripture-search-btn');
const scriptureSearchClear = document.getElementById('scripture-search-clear');
const translationSelect    = document.getElementById('translation-select');

// Settings inputs
const deepgramKeyInput    = document.getElementById('deepgram-key');
const ppUrlInput          = document.getElementById('propresenter-url');
const translationSettings = document.getElementById('translation-select-settings');
const swapPPBtn           = document.getElementById('swap-pp-tokens-btn');
const ppTokenOrderLabel   = document.getElementById('pp-token-order-label');
const showConfSettings    = document.getElementById('show-confidence-settings');
const audioSourceSettings = document.getElementById('audio-source-settings');
const refreshDevicesBtn   = document.getElementById('refresh-devices-settings');
const obsEnabledToggle   = document.getElementById('obs-enabled-toggle');
const obsUrlInput        = document.getElementById('obs-url');
const obsPasswordInput   = document.getElementById('obs-password');
const obsTextSourceInput = document.getElementById('obs-text-source');
const testObsBtn         = document.getElementById('test-obs-btn');
const obsStatusEl        = document.getElementById('obs-status');
const ppEnabledToggle    = document.getElementById('pp-enabled-toggle');

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(wsReconnectTimer);
    updatePPStatus('Checking…', '');
    loadSettings();
    initCustomSelects();
    checkPP();
  };

  ws.onmessage = (ev) => {
    try { const m = JSON.parse(ev.data); if (m.type !== 'transcript') console.log('[WS]', m.type, JSON.stringify(m).slice(0,150)); } catch {}

    try { handleServerMessage(JSON.parse(ev.data)); } catch {}
  };

  ws.onclose = () => {
    console.warn('[WS] Disconnected — reconnecting in 2s…');
    wsReconnectTimer = setTimeout(connectWS, 2000);
  };

  ws.onerror = () => ws.close();
}

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'worker-ready':
      workerReady = true;
      if (workerStatusEl) { workerStatusEl.textContent = 'Engine ready'; workerStatusEl.style.color = 'var(--green)'; }
      break;

    case 'worker-error':
      workerReady = false;
      if (workerStatusEl) { workerStatusEl.textContent = 'Engine error'; workerStatusEl.style.color = 'var(--red)'; }
      toast('Detection engine error: ' + msg.error, 'error');
      break;

    case 'worker-status':
      workerReady = msg.ready || false;
      if (workerStatusEl) {
        workerStatusEl.textContent = msg.ready ? 'Engine ready' : 'Engine loading…';
        workerStatusEl.style.color = msg.ready ? 'var(--green)' : 'var(--text-2)';
      }
      break;

    case 'connection-state':
      handleConnectionState(msg.state, msg.error);
      break;

    case 'transcript':
      handleTranscript(msg);
      break;

    case 'detection':
      handleDetection(msg);
      break;

    case 'propresenter-success':
      handlePPSuccess(msg.verse);
      break;

    case 'propresenter-error':
      updatePPStatus('Error', 'error');
      break;

    case 'range-state':
      handleRangeState(msg);
      break;

    case 'range-verses':
      handleRangeVerses(msg);
      break;

    case 'range-active':
      handleRangeActive(msg.activeRef);
      break;

  }
}

// ── Connection state ───────────────────────────────────────────────────────
function handleConnectionState(state, error) {
  const micPill = document.querySelector('.pill-green');
  const micLabel = micPill?.querySelector('.pill-dot');
  // Left sidebar broadcasting indicator
  const lsBcastDot = document.getElementById('ls-bcast-dot');
  const lsBcastLbl = document.getElementById('ls-bcast-label');

  if (state === 'connected') {
    isListening = true;
    if (listenText) listenText.textContent = 'Stop Listening';
    listenBtn?.querySelector('svg rect')?.setAttribute('fill', 'currentColor');
    if (micLabel) micLabel.classList.add('pulse');
    if (lsBcastDot) lsBcastDot.classList.add('broadcasting');
    if (lsBcastLbl) { lsBcastLbl.classList.add('broadcasting'); lsBcastLbl.textContent = 'Broadcasting'; }
    if (!startTime) {
      startTime = Date.now();
      elapsedInterval = setInterval(updateElapsed, 1000);
    }
    showEmptyTranscript(false);
  } else if (state === 'disconnected' || state === 'error') {
    isListening = false;
    if (listenText) listenText.textContent = 'Start Listening';
    if (micLabel) micLabel.classList.remove('pulse');
    if (lsBcastDot) lsBcastDot.classList.remove('broadcasting');
    if (lsBcastLbl) { lsBcastLbl.classList.remove('broadcasting'); lsBcastLbl.textContent = 'Idle'; }
    stopAudioCapture();
    if (state === 'error' && error) toast(error, 'error');
  } else if (state === 'connecting') {
    if (listenText) listenText.textContent = 'Connecting…';
    if (lsBcastLbl) lsBcastLbl.textContent = 'Connecting…';
  }
}

// ── Transcript ─────────────────────────────────────────────────────────────
let transcriptDiv = null;
let interimSpan   = null;

function showEmptyTranscript(show) {
  if (!transcriptContent) return;
  if (show) {
    transcriptContent.innerHTML = '<div class="empty-state-sm"><p>Click <strong>Start</strong> to begin live transcription</p></div>';
    transcriptDiv = null; interimSpan = null;
  } else if (!transcriptDiv) {
    transcriptContent.innerHTML = '';
    transcriptDiv = document.createElement('div');
    transcriptDiv.className = 'transcript-text';
    transcriptContent.appendChild(transcriptDiv);
    interimSpan = document.createElement('span');
    interimSpan.className = 'transcript-interim';
    transcriptDiv.appendChild(interimSpan);
  }
}

function handleTranscript(msg) {
  if (!transcriptDiv) showEmptyTranscript(false);
  if (msg.isFinal) {
    const span = document.createElement('span');
    span.className = 'transcript-final';
    span.textContent = msg.text + ' ';
    if (interimSpan) transcriptDiv.insertBefore(span, interimSpan);
    else transcriptDiv.appendChild(span);
    if (interimSpan) interimSpan.textContent = '';
    wordCount += msg.text.split(/\s+/).length;
    if (wordCountEl) wordCountEl.textContent = wordCount.toLocaleString();
    // Auto-scroll
    transcriptContent.scrollTop = transcriptContent.scrollHeight;
  } else {
    if (interimSpan) { interimSpan.textContent = msg.text; interimSpan.style.opacity = '0.5'; }
    transcriptContent.scrollTop = transcriptContent.scrollHeight;
  }
}

// ── Detection routing ──────────────────────────────────────────────────────
// Client-side score gate matches server — belt-and-suspenders so stale WS
// messages from a previous session can't populate SENT with low-confidence hits.
const CLIENT_VIEWER_MIN_SCORE = 0.80;

function handleDetection(msg) {
  const { verses, method, target, topScore, correctedFrom } = msg;
  if (!verses?.length) return;

  if (target === 'viewer' && (topScore == null || topScore >= CLIENT_VIEWER_MIN_SCORE)) {
    showInViewer(verses, method, topScore, correctedFrom);
  } else {
    showInSuggestions(verses, method);
  }
}

// Update only the viewer display (preview panel) without touching queue order.
// Use this for dblclick on already-queued cards so they don't reorder.
function updateViewerDisplay(v) {
  if (previewVerseText) previewVerseText.textContent = cleanVerseText(v.text);
  if (previewVerseRef)  previewVerseRef.textContent  = v.reference || '';
}

function showInViewer(verses, method, topScore, correctedFrom = null) {
  const v = verses[0];

  // Update live preview screen
  if (previewVerseText) previewVerseText.textContent = cleanVerseText(v.text);
  if (previewVerseRef)  previewVerseRef.textContent  = v.reference || '';

  // Auto-correction: strip the mis-cited row so it doesn't linger above the fix.
  if (correctedFrom) {
    const stale = currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(correctedFrom)}"]`);
    stale?.remove();
    const staleCand = queueList?.querySelector(`[data-ref="${CSS.escape(correctedFrom)}"]`);
    staleCand?.remove();
  }

  // ── Live Queue — the single list of sent + queued verses ──
  if (currentDisplayCard) {
    const isEmpty = currentDisplayCard.querySelector('.display-empty, .cs-queue-empty');
    if (isEmpty) isEmpty.remove();

    if (rangeRefs.has(v.reference)) {
      // Range verse auto-advancing — just shift the highlight
      handleRangeActive(v.reference);
    } else {
      // Regular sent verse — full-list dedup (not just top card)
      const existing = currentDisplayCard.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`);
      if (existing) {
        // Already in list — pulse it and bring to top
        existing.classList.remove('sent-pulse');
        void existing.offsetWidth;
        existing.classList.add('sent-pulse');
        currentDisplayCard.insertBefore(existing, currentDisplayCard.firstChild);
      } else {
        const card = buildQueueRow(v, method, correctedFrom);
        currentDisplayCard.insertBefore(card, currentDisplayCard.firstChild);
        // Trim to keep session manageable (50 entries)
        const children = currentDisplayCard.children;
        if (children.length > 50) {
          const frag = document.createDocumentFragment();
          while (children.length > 50) frag.appendChild(children[children.length - 1]);
          // frag is discarded, removing all excess elements in one reflow
        }
      }
    }
  }

  verseCount++;
  if (verseCountEl) verseCountEl.textContent = verseCount;
  if (v.similarity) {
    allConfidences.push(v.similarity);
    const avg = allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length;
    if (avgConfidenceEl) avgConfidenceEl.textContent = (avg * 100).toFixed(0) + '%';
  }
  sessionVerses.push({ ref: v.reference, text: v.text, time: new Date().toLocaleTimeString() });

  // ── Candidates panel — log every sent verse, upgrade existing cards to sent ──
  if (queueList) {
    queueList.querySelector('.display-empty')?.remove();
    const existing = queueList.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`);
    if (existing) {
      // Already in panel — mark green in place, no reorder
      existing.classList.add('cand-sent');
    } else {
      // New verse — prepend as a sent record
      const record = buildCandidateCard(v, method, true);
      queueList.insertBefore(record, queueList.firstChild);
    }
    updateSuggestionCount();
  }
}

function clearSuggestionsPanel() {
  if (!queueList) return;
  queueList.innerHTML = '<div class="display-empty">Listening…</div>';
  updateSuggestionCount();
}

function showInSuggestions(verses, method) {
  if (!queueList) return;
  queueList.querySelector('.display-empty')?.remove();

  const frag = document.createDocumentFragment();
  for (const v of verses) {
    if (queueList.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`)) continue;
    frag.appendChild(buildCandidateCard(v, method));
  }
  if (frag.childNodes.length) queueList.insertBefore(frag, queueList.firstChild);

  const queueChildren = queueList.children;
  if (queueChildren.length > 50) {
    const trimFrag = document.createDocumentFragment();
    while (queueChildren.length > 50) trimFrag.appendChild(queueChildren[queueChildren.length - 1]);
    // trimFrag is discarded, removing all excess elements in one reflow
  }
  updateSuggestionCount();
}

// Purpose-built compact card for the Candidates panel
function buildCandidateCard(v, method, isSent = false) {
  const pct  = v.similarity != null ? Math.round(v.similarity * 100) : null;
  const conf = pct != null ? pct + '%' : '';
  const tier = pct == null ? '' : pct >= 90 ? 'conf-high' : pct >= 80 ? 'conf-good' : pct >= 60 ? 'conf-mid' : 'conf-low';

  const card = document.createElement('div');
  card.className = 'cand-card' + (isSent ? ' cand-sent' : '');
  card.dataset.ref = v.reference;
  card.innerHTML = `
    <div class="cand-row">
      <span class="cand-ref">${v.reference}</span>
      ${conf ? `<span class="cand-badge ${tier}">${conf}</span>` : ''}
    </div>
    <div class="cand-text">${cleanVerseText(v.text)}</div>
    <div class="cand-actions">
      <button class="cand-send">Send to Air</button>
      <button class="cand-promote">Promote</button>
    </div>
  `;
  const sendBtn = card.querySelector('.cand-send');
  const promoteBtn = card.querySelector('.cand-promote');
  sendBtn?.addEventListener('click', () => {
    card.classList.add('cand-sent'); // mark green in place — no reorder
    showInViewer([v], method || 'direct', 1.0);
    sendVerseToServer(v);
  });
  promoteBtn?.addEventListener('click', () => {
    // Promote = send to viewer only (no PP), remove from candidates
    showInViewer([v], method || 'direct', 1.0);
    card.remove();
    updateSuggestionCount();
  });
  return card;
}

// Compact single-row card for the Live Queue section
function buildQueueRow(v, method, correctedFrom = null) {
  const card = document.createElement('div');
  card.dataset.ref = v.reference;
  card.className = 'locked-verse-card' + (correctedFrom ? ' corrected' : '');
  const abbr = refToBadgeAbbr(v.reference);
  const correctedChip = correctedFrom
    ? `<span class="corrected-chip" title="Auto-corrected from ${correctedFrom}">corrected from ${correctedFrom}</span>`
    : '';
  card.innerHTML = `
    <div class="history-book-badge">${abbr}</div>
    <div class="history-card-content">
      <div class="lvc-ref">${v.reference}${correctedChip}</div>
      <div class="lvc-text">${cleanVerseText(v.text)}</div>
    </div>
    <div class="lvc-actions">
      <button class="lvc-send-btn" title="Send to screen">Send</button>
    </div>
  `;
  // Send button → update viewer + ProPresenter
  const sendBtn = card.querySelector('.lvc-send-btn');
  sendBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showInViewer([v], method || 'direct', 1.0);
    sendVerseToServer(v);
  });
  // Double-click anywhere on card → send to screen (no reorder)
  card.addEventListener('dblclick', (e) => {
    e.preventDefault();
    updateViewerDisplay(v);   // update preview only — card stays in place
    sendVerseToServer(v);
    // Flash feedback
    card.classList.add('sent-pulse');
    setTimeout(() => card.classList.remove('sent-pulse'), 600);
  });
  return card;
}

function buildVerseCard(v, method, role) {
  const card = document.createElement('div');
  card.dataset.ref = v.reference;

  const pct         = v.similarity != null ? Math.round(v.similarity * 100) : null;
  const conf        = pct != null ? pct + '%' : '';
  const isSent      = role === 'sent';
  const showConf    = settings.showConfidence !== false;
  const statusLabel = method === 'direct' ? 'Reference' : method === 'fingerprint' ? 'Context' : 'Phrase';

  const badgeTier = pct == null  ? '' :
                    pct >= 90    ? 'conf-high' :
                    pct >= 80    ? 'conf-good' :
                    pct >= 60    ? 'conf-mid'  : 'conf-low';

  // Short book abbreviation for history grid badge: "Matthew 17:21" → "MT·17",
  // "1 Chronicles 6:18" → "1CH·6". Without the numbered-book branch the pill
  // overflows with the full book name.
  const abbr = refToBadgeAbbr(v.reference);

  card.className = isSent ? 'locked-verse-card' : 'suggestion-card';

  if (isSent) {
    // Compact history layout: abbreviation badge | reference + text | send button
    card.innerHTML = `
      <div class="history-book-badge">${abbr}</div>
      <div class="history-card-content">
        <div class="lvc-ref">${v.reference}</div>
        <div class="lvc-text">${cleanVerseText(v.text)}</div>
      </div>
      <div class="lvc-actions">
        <button class="lvc-send-btn" title="Resend to ProPresenter">Send</button>
      </div>
    `;
  } else {
    // Full suggestion card: method label + conf badge + reference + verse + actions
    const detBadgeClass = method === 'direct' ? 'det-badge--direct' :
                          method === 'verbatim' ? 'det-badge--verbatim' :
                          method === 'fingerprint' ? 'det-badge--fingerprint' : '';
    const detBadgeLabel = method === 'direct' ? 'DIRECT' :
                          method === 'verbatim' ? 'QUOTE' :
                          method === 'fingerprint' ? 'PHRASE' : method || '';
    const topScorePct = v.similarity != null ? Math.round(v.similarity * 100) + '%' : '';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        ${detBadgeClass ? `<span class="det-badge ${detBadgeClass}">${detBadgeLabel}</span>` : ''}
        ${topScorePct ? `<span style="font-size:10px;color:var(--text-3);">${topScorePct}</span>` : ''}
      </div>
      ${showConf && conf ? `<span class="conf-badge ${badgeTier}">${conf}</span>` : ''}
      <div class="lvc-status">${statusLabel}</div>
      <div class="lvc-ref">${v.reference}</div>
      <div class="lvc-text">&ldquo;${cleanVerseText(v.text)}&rdquo;</div>
      <div class="lvc-actions">
        <button class="lvc-send-btn">Send to Air</button>
        <button class="lvc-promote-btn">Promote</button>
      </div>
    `;
  }

  const sendBtn = card.querySelector('.lvc-send-btn');
  const promoteBtn = card.querySelector('.lvc-promote-btn');
  sendBtn?.addEventListener('click', () => {
    sendVerseToServer(v);
  });
  promoteBtn?.addEventListener('click', () => {
    showInViewer([v], method);
    card.remove();
    updateSuggestionCount();
  });

  return card;
}

function updateSuggestionCount() {
  const count = queueList?.children.length ?? 0;
  if (suggestionCount) suggestionCount.textContent = count;
  const badge = document.getElementById('suggestion-count-badge');
  if (badge) badge.textContent = count;
}

// ── ProPresenter UI ────────────────────────────────────────────────────────
// ── Range navigation bar (docked below live screen) ────────────────────────
const rangeNavBar   = document.getElementById('range-nav-bar');
const rangeNavLabel = document.getElementById('range-nav-label');
const rangeNavRef   = document.getElementById('range-nav-ref');

// Wire the nav buttons once (they live in the HTML, not rebuilt per state)
document.getElementById('range-next-btn')?.addEventListener('click', async () => {
  await fetch(`${SERVER}/api/range/next`, { method: 'POST' });
});
document.getElementById('range-clear-btn')?.addEventListener('click', async () => {
  await fetch(`${SERVER}/api/range/clear`, { method: 'POST' });
});

function handleRangeState({ remaining, total, next }) {
  // Range complete — hide nav bar, convert range cards to regular history
  // cards (keep them visible, just strip the range-specific styling).
  if (!remaining || !total) {
    if (rangeNavBar) rangeNavBar.style.display = 'none';
    currentDisplayCard?.querySelectorAll('.range-verse-card').forEach(el => {
      el.classList.remove('range-verse-card', 'range-active', 'range-queued');
      // Strip the blue range badge tint so it looks like a normal history card
      el.querySelector('.range-book-badge')?.classList.remove('range-book-badge');
    });
    rangeRefs = new Set();
    return;
  }

  // Show and update the nav bar docked below the live screen
  if (rangeNavBar) {
    rangeNavBar.style.display = 'flex';
    const current = total - remaining; // verses already shown (1-based)
    if (rangeNavLabel) rangeNavLabel.textContent = `Range  ${current} / ${total}`;
    if (rangeNavRef)   rangeNavRef.textContent   = next ? `→ ${next.reference}` : 'Last verse';
  }
}

// ── Range verse display ─────────────────────────────────────────────────────
// Called once when a range is first set — renders all verses into history grid
// with the active one highlighted. Subsequent 'range-active' events just shift
// the highlight as the sermon advances through the range.

function handleRangeVerses({ verses, activeRef }) {
  if (!currentDisplayCard || !verses?.length) return;

  // Mark all range refs so showInViewer dedup doesn't fight us
  rangeRefs = new Set(verses.map(v => v.reference));

  // Clear placeholders
  currentDisplayCard.querySelectorAll('.display-empty, .cs-queue-empty').forEach(el => el.remove());

  // Remove stale range cards from a previous range
  currentDisplayCard.querySelectorAll('.range-verse-card').forEach(el => el.remove());

  // Remove any existing sent/queue cards whose refs overlap with this range
  // (prevents duplicates when preacher calls a range that includes already-sent verses)
  if (rangeRefs.size) {
    currentDisplayCard.querySelectorAll('[data-ref]').forEach(el => {
      if (rangeRefs.has(el.dataset.ref)) el.remove();
    });
  }

  // Insert all range cards at the top (reversed so first verse ends up first)
  const fragment = document.createDocumentFragment();
  for (const v of [...verses].reverse()) {
    fragment.appendChild(buildRangeCard(v, v.reference === activeRef));
  }
  currentDisplayCard.insertBefore(fragment, currentDisplayCard.firstChild);

  // Update live preview to the active verse
  const active = verses.find(v => v.reference === activeRef) || verses[0];
  if (active) {
    if (previewVerseText) previewVerseText.textContent = cleanVerseText(active.text);
    if (previewVerseRef)  previewVerseRef.textContent  = active.reference || '';
  }
}

function handleRangeActive(activeRef) {
  if (!currentDisplayCard || !activeRef) return;
  currentDisplayCard.querySelectorAll('.range-verse-card').forEach(card => {
    const isActive = card.dataset.ref === activeRef;
    card.classList.toggle('range-active', isActive);
    card.classList.toggle('range-queued', !isActive);
  });
  // Update live preview
  const activeCard = currentDisplayCard.querySelector(`.range-verse-card[data-ref="${activeRef}"]`);
  if (activeCard) {
    const refEl  = activeCard.querySelector('.lvc-ref');
    const textEl = activeCard.querySelector('.lvc-text');
    if (previewVerseText && textEl) previewVerseText.textContent = textEl.textContent;
    if (previewVerseRef  && refEl)  previewVerseRef.textContent  = refEl.textContent;
  }
}

function buildRangeCard(v, isActive) {
  const card = document.createElement('div');
  card.dataset.ref = v.reference;
  card.className   = 'range-verse-card locked-verse-card' + (isActive ? ' range-active' : ' range-queued');

  const abbr = refToBadgeAbbr(v.reference);

  card.innerHTML = `
    <div class="history-book-badge range-book-badge">${abbr}</div>
    <div class="history-card-content">
      <div class="lvc-ref">${v.reference}</div>
      <div class="lvc-text">${cleanVerseText(v.text || v.kjv_text || '')}</div>
    </div>
    <div class="lvc-actions">
      <button class="lvc-send-btn" title="Send to ProPresenter">Send</button>
    </div>
  `;

  const sendBtn = card.querySelector('.lvc-send-btn');
  sendBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showInViewer([v], 'direct', 1.0);
    sendVerseToServer(v);
  });

  card.addEventListener('dblclick', (e) => {
    e.preventDefault();
    updateViewerDisplay(v);   // update preview only — card stays in place
    sendVerseToServer(v);
    card.classList.add('sent-pulse');
    setTimeout(() => card.classList.remove('sent-pulse'), 600);
  });

  return card;
}

function handlePPSuccess(verse) {
  updatePPStatus('Connected', 'connected');
  if (verse) {
    toast(`Sent: ${verse.reference}`, 'success');
    if (previewVerseText) previewVerseText.textContent = cleanVerseText(verse.text);
    if (previewVerseRef)  previewVerseRef.textContent  = verse.reference;
  }
}

function updatePPStatus(text, cls) {
  if (proPresenterStatus) proPresenterStatus.textContent = text;
  if (propresenterDot) {
    propresenterDot.className = 'bs-dot' + (cls ? ' ' + cls : '');
  }
}

async function checkPP() {
  try {
    const r = await fetch(`${SERVER}/api/propresenter/test`);
    const d = await r.json();
    if (d.success) updatePPStatus('Connected', 'connected');
    else           updatePPStatus('Not found', 'error');
  } catch { updatePPStatus('Offline', ''); }
}

async function sendVerseToServer(verse) {
  try {
    await fetch(`${SERVER}/api/propresenter/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verse }),
    });
  } catch (err) { toast('ProPresenter send failed: ' + err.message, 'error'); }
}

// ── Listening / Audio ──────────────────────────────────────────────────────
listenBtn?.addEventListener('click', async () => {
  if (isListening) {
    await stopListening();
  } else {
    await startListening();
  }
});

async function startListening() {
  if (isListening) return;
  try {
    const deviceId = audioSourceSettings?.value || '';
    const constraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
        : { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (micDisplay) micDisplay.textContent = mediaStream.getAudioTracks()[0]?.label || 'Microphone';

    // Start server-side Deepgram
    const r = await fetch(`${SERVER}/api/start-listening`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (d.error) { toast(d.error, 'error'); stopAudioCapture(); return; }

    // Stream PCM16 to server via WebSocket
    audioContext  = new AudioContext({ sampleRate: 16000 });
    const source  = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    audioProcessor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16   = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      ws.send(int16.buffer);
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);

    showEmptyTranscript(false);
  } catch (err) {
    toast('Mic error: ' + err.message, 'error');
    stopAudioCapture();
  }
}

async function stopListening() {
  await fetch(`${SERVER}/api/stop-listening`, { method: 'POST' }).catch(err => console.warn('[KAIRO] stop-listening request failed:', err.message));
  stopAudioCapture();
  clearInterval(elapsedInterval);
}

function stopAudioCapture() {
  if (audioProcessor) { try { audioProcessor.disconnect(); } catch {} audioProcessor = null; }
  if (audioContext)   { try { audioContext.close(); }       catch {} audioContext   = null; }
  if (mediaStream)    { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// ── Custom Select Dropdowns ───────────────────────────────────────────────
// Replaces native <select> elements with a fully styled custom component.
// Usage: call initCustomSelects() after DOM is ready.
function buildCustomSelect(nativeSelect) {
  if (!nativeSelect || nativeSelect.dataset.customized) return;
  nativeSelect.dataset.customized = '1';
  nativeSelect.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'cs-select-wrapper';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-select-trigger setting-input';

  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'cs-select-value';

  const triggerArrow = document.createElement('span');
  triggerArrow.className = 'cs-select-arrow';
  triggerArrow.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  trigger.appendChild(triggerLabel);
  trigger.appendChild(triggerArrow);

  const dropdown = document.createElement('div');
  dropdown.className = 'cs-select-dropdown';

  function buildOptions() {
    dropdown.innerHTML = '';
    Array.from(nativeSelect.options).forEach(opt => {
      const item = document.createElement('div');
      item.className = 'cs-select-option' + (opt.selected ? ' selected' : '');
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        nativeSelect.value = opt.value;
        nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        triggerLabel.textContent = opt.textContent;
        dropdown.querySelectorAll('.cs-select-option').forEach(o => o.classList.toggle('selected', o.dataset.value === opt.value));
        close();
      });
      dropdown.appendChild(item);
    });
    const sel = nativeSelect.options[nativeSelect.selectedIndex];
    if (sel) triggerLabel.textContent = sel.textContent;
  }

  function open() {
    dropdown.classList.add('open');
    trigger.classList.add('open');
    // Close all others
    document.querySelectorAll('.cs-select-dropdown.open').forEach(d => {
      if (d !== dropdown) { d.classList.remove('open'); d.closest('.cs-select-wrapper')?.querySelector('.cs-select-trigger')?.classList.remove('open'); }
    });
  }
  function close() {
    dropdown.classList.remove('open');
    trigger.classList.remove('open');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.contains('open') ? close() : open();
  });

  document.addEventListener('click', close);

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  nativeSelect.parentNode.insertBefore(wrapper, nativeSelect);
  nativeSelect.parentNode.insertBefore(nativeSelect, wrapper); // keep native before wrapper for form submit

  buildOptions();

  // Watch for programmatic changes to native select
  const observer = new MutationObserver(buildOptions);
  observer.observe(nativeSelect, { childList: true, attributes: true, subtree: true });
}

function initCustomSelects() {
  document.querySelectorAll('select.setting-input:not([data-customized])').forEach(buildCustomSelect);
}

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const r = await fetch(`${SERVER}/api/settings`);
    settings = await r.json();
    // Populate UI
    if (deepgramKeyInput && settings.deepgramApiKey) deepgramKeyInput.value = settings.deepgramApiKey;
    if (ppUrlInput && settings.proPresenterUrl) ppUrlInput.value = settings.proPresenterUrl;
    if (translationSettings && settings.translation) translationSettings.value = settings.translation;
    if (translationSelect && settings.translation)   translationSelect.value   = settings.translation;
    if (autoSendCheckbox)  autoSendCheckbox.checked  = settings.autoSend  !== false;
    if (autoSendSettings)  autoSendSettings.checked  = settings.autoSend  !== false;
    if (showConfSettings)  showConfSettings.checked   = settings.showConfidence !== false;
    if (ppEnabledToggle)    ppEnabledToggle.checked    = settings.proPresenterEnabled !== false;
    if (obsEnabledToggle)   obsEnabledToggle.checked   = settings.obsEnabled === true;
    if (obsUrlInput && settings.obsUrl) obsUrlInput.value = settings.obsUrl;
    if (obsPasswordInput && settings.obsPassword) obsPasswordInput.value = settings.obsPassword;
    if (obsTextSourceInput && settings.obsTextSource) obsTextSourceInput.value = settings.obsTextSource;
    updatePPTokenLabel();
    initCustomSelects();
    // First-run: no Deepgram key → show a nudge banner so the user knows what to do.
    showFirstRunBannerIfNeeded(settings);
  } catch {}
}

// ── First-run onboarding banner ────────────────────────────────────────────
function showFirstRunBannerIfNeeded(s) {
  const existing = document.getElementById('first-run-banner');
  if (s && s.deepgramApiKey) {
    // Key is now set — remove banner if it was showing.
    if (existing) existing.remove();
    return;
  }
  if (existing) return; // already showing
  const banner = document.createElement('div');
  banner.id = 'first-run-banner';
  banner.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <span>No Deepgram API key — KAIRO won't detect verses until you add one.</span>
    <button class="frb-btn" id="frb-open-settings">Open Settings</button>
    <button class="frb-close" id="frb-close" aria-label="Dismiss">✕</button>
  `;
  // Insert at the very top of the page, above everything.
  document.body.insertBefore(banner, document.body.firstChild);
  document.getElementById('frb-open-settings').addEventListener('click', () => {
    settingsModal?.classList.add('open');
    deepgramKeyInput?.focus();
  });
  document.getElementById('frb-close').addEventListener('click', () => banner.remove());
}

async function saveCurrentSettings() {
  const updated = {
    deepgramApiKey:    deepgramKeyInput?.value    || settings.deepgramApiKey,
    proPresenterUrl:   ppUrlInput?.value          || 'http://localhost:1025',
    translation:       translationSettings?.value || 'KJV',
    ppSwapTokenOrder:  settings.ppSwapTokenOrder  || false,
    autoSend:          autoSendSettings?.checked  !== false,
    showConfidence:    showConfSettings?.checked   !== false,
    proPresenterEnabled: ppEnabledToggle?.checked !== false,
    obsEnabled:          obsEnabledToggle?.checked === true,
    obsUrl:              obsUrlInput?.value        || 'ws://localhost:4455',
    obsPassword:         obsPasswordInput?.value   || '',
    obsTextSource:       obsTextSourceInput?.value || 'Scripture',
  };
  await fetch(`${SERVER}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  settings = { ...settings, ...updated };
  if (translationSelect && updated.translation) translationSelect.value = updated.translation;
  // Dismiss first-run banner now that a key may have been entered.
  showFirstRunBannerIfNeeded(settings);
  closeModal();
  toast('Settings saved', 'success');
  checkPP();
}

function updatePPTokenLabel() {
  if (!ppTokenOrderLabel) return;
  const swapped = settings.ppSwapTokenOrder;
  ppTokenOrderLabel.textContent = swapped
    ? 'Token[0] = Reference · Token[1] = Verse Text'
    : 'Token[0] = Verse Text · Token[1] = Reference';
}

settingsBtn?.addEventListener('click',    () => settingsModal?.classList.remove('hidden'));
closeSettingsBtn?.addEventListener('click', closeModal);
cancelSettingsBtn?.addEventListener('click', closeModal);
saveSettingsBtn?.addEventListener('click',  saveCurrentSettings);
document.querySelector('.modal-overlay')?.addEventListener('click', closeModal);

testPPBtn?.addEventListener('click', async () => {
  testPPBtn.textContent = 'Testing…';
  const r   = await fetch(`${SERVER}/api/propresenter/test`);
  const d   = await r.json();
  testPPBtn.textContent = 'Test';
  if (d.success) { updatePPStatus('Connected', 'connected'); toast('ProPresenter connected: ' + d.version, 'success'); }
  else           { updatePPStatus('Not found', 'error');     toast('ProPresenter: ' + d.error, 'error'); }
});

testObsBtn?.addEventListener('click', async () => {
  testObsBtn.textContent = 'Testing…';
  if (obsStatusEl) obsStatusEl.textContent = '';
  try {
    const r = await fetch(`${SERVER}/api/obs/test`);
    const d = await r.json();
    testObsBtn.textContent = 'Test';
    if (d.success) {
      if (obsStatusEl) { obsStatusEl.textContent = 'Connected (OBS ' + d.version + ')'; obsStatusEl.style.color = 'var(--green)'; }
      toast('OBS connected: v' + d.version, 'success');
    } else {
      if (obsStatusEl) { obsStatusEl.textContent = 'Failed: ' + d.error; obsStatusEl.style.color = 'var(--red)'; }
      toast('OBS: ' + d.error, 'error');
    }
  } catch (e) {
    testObsBtn.textContent = 'Test';
    if (obsStatusEl) { obsStatusEl.textContent = 'Error: ' + e.message; obsStatusEl.style.color = 'var(--red)'; }
  }
});

swapPPBtn?.addEventListener('click', async () => {
  settings.ppSwapTokenOrder = !settings.ppSwapTokenOrder;
  updatePPTokenLabel();
  await fetch(`${SERVER}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ppSwapTokenOrder: settings.ppSwapTokenOrder }),
  });
});

autoSendCheckbox?.addEventListener('change', async () => {
  settings.autoSend = autoSendCheckbox.checked;
  if (autoSendSettings) autoSendSettings.checked = autoSendCheckbox.checked;
  await fetch(`${SERVER}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoSend: settings.autoSend }) });
});

function closeModal() { settingsModal?.classList.add('hidden'); }

// ── Scripture Search ───────────────────────────────────────────────────────
scriptureSearchBtn?.addEventListener('click', runSearch);
scriptureSearchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
scriptureSearchInput?.addEventListener('input', () => {
  if (scriptureSearchClear) scriptureSearchClear.style.display = scriptureSearchInput.value ? 'flex' : 'none';
});
scriptureSearchClear?.addEventListener('click', () => {
  if (scriptureSearchInput) scriptureSearchInput.value = '';
  if (scriptureSearchClear) scriptureSearchClear.style.display = 'none';
});

async function runSearch() {
  const raw = scriptureSearchInput?.value?.trim();
  if (!raw) return;

  // Visual feedback — dim the button while searching
  if (scriptureSearchBtn) scriptureSearchBtn.style.opacity = '0.5';

  try {
    const r = await fetch(`${SERVER}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: raw }),
    });

    if (!r.ok) {
      // Server-side error (500, 400 etc.) — try text fallback
      const err = await r.json().catch(() => ({}));
      console.warn('[Search] Server error:', err);
      toast('Search error — try again', 'error');
      return;
    }

    const d = await r.json();
    console.log('[Search] response:', d.method, d.result?.reference ?? (d.results?.length + ' text hits'));

    if (d.result) {
      // Reference hit — send to viewer + ProPresenter immediately
      const allVerses = d.range?.length > 1 ? d.range : [d.result];
      if (allVerses.length > 1) {
        // Range — let the WS broadcast handle the range-verses event,
        // but also seed the viewer with the first verse right now
        showInViewer(allVerses, d.method || 'direct', 1.0);
      } else {
        showInViewer([d.result], d.method || 'direct', 1.0);
      }
      sendVerseToServer(d.result);
      // Keep the text so the user can quickly extend to a range (e.g. add "-18")
      if (scriptureSearchInput) {
        scriptureSearchInput.select(); // select all → ready to retype or append
      }

    } else if (d.results?.length) {
      // Phrase / keyword search → show as candidates
      showInSuggestions(d.results, d.method || 'search');

    } else {
      toast(`No match for "${raw}"`, 'error');
    }

  } catch (err) {
    console.error('[Search] fetch failed:', err);
    toast('Cannot reach server — is it running?', 'error');
  } finally {
    if (scriptureSearchBtn) scriptureSearchBtn.style.opacity = '';
  }
}


// ── Clear buttons ──────────────────────────────────────────────────────────
clearLockedBtn?.addEventListener('click', async () => {
  if (currentDisplayCard) {
    currentDisplayCard.innerHTML = '<div class="cs-queue-empty">Sent verses and range queues appear here…</div>';
  }
  rangeRefs = new Set();
  if (previewVerseText) previewVerseText.textContent = 'Nothing on display';
  if (previewVerseRef)  previewVerseRef.textContent  = '';
  await fetch(`${SERVER}/api/propresenter/clear`, { method: 'POST' }).catch(err => console.warn('[KAIRO] propresenter/clear request failed:', err.message));
});

clearSuggestionsBtn?.addEventListener('click', () => {
  if (queueList) queueList.innerHTML = '<div class="display-empty">Contextual detections appear here</div>';
  if (suggestionCount) suggestionCount.textContent = '0';
});

clearTranscriptBtn?.addEventListener('click', () => {
  showEmptyTranscript(true);
  wordCount = 0;
  if (wordCountEl) wordCountEl.textContent = '0';
});

// ── Audio device enumeration ───────────────────────────────────────────────
async function populateAudioDevices() {
  if (!audioSourceSettings) return;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    audioSourceSettings.innerHTML = '';
    mics.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${d.deviceId.slice(0, 6)}`;
      audioSourceSettings.appendChild(o);
    });
  } catch {}
}

refreshDevicesBtn?.addEventListener('click', populateAudioDevices);

// ── Export ─────────────────────────────────────────────────────────────────
exportBtn?.addEventListener('click', exportSession);
function exportSession() {
  if (!sessionVerses.length) { toast('No verses to export', 'info'); return; }
  const lines = sessionVerses.map(v => `${v.time}  ${v.ref}\n${v.text}\n`).join('\n');
  const blob  = new Blob([lines], { type: 'text/plain' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `KAIRO_session_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Elapsed timer ──────────────────────────────────────────────────────────
function updateElapsed() {
  if (!startTime) return;
  const s   = Math.floor((Date.now() - startTime) / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  const str = `${min}:${sec.toString().padStart(2, '0')}`;
  if (elapsedTimeEl)   elapsedTimeEl.textContent   = str;
  if (elapsedMetricEl) elapsedMetricEl.textContent = str;
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  if (!toastContainer) return;
  const el  = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.classList.add('visible'), 10);
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 3500);
}

// ── Platform class ─────────────────────────────────────────────────────────
if (navigator.userAgent.includes('Mac')) document.body.classList.add('platform-darwin');

// ── Boot ───────────────────────────────────────────────────────────────────
populateAudioDevices();

// ── Theme Studio ──────────────────────────────────────────────────────────

const FONTS = [
  { label: 'Manrope',            value: 'Manrope',            google: true  },
  { label: 'Inter',              value: 'Inter',              google: true  },
  { label: 'Montserrat',         value: 'Montserrat',         google: true  },
  { label: 'Raleway',            value: 'Raleway',            google: true  },
  { label: 'Open Sans',          value: 'Open Sans',          google: true  },
  { label: 'Playfair Display',   value: 'Playfair Display',   google: true  },
  { label: 'Cormorant Garamond', value: 'Cormorant Garamond', google: true  },
  { label: 'EB Garamond',        value: 'EB Garamond',        google: true  },
  { label: 'Cinzel',             value: 'Cinzel',             google: true  },
  { label: 'Bebas Neue',         value: 'Bebas Neue',         google: true  },
  { label: 'System UI',          value: 'system-ui',          google: false },
];

const loadedFonts = new Set(['Manrope', 'system-ui']);

function loadGoogleFont(family) {
  if (loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@100;200;300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
}

const DEFAULT_LOOKS = [
  {
    id: 'default', name: 'Default', layout: 'fullscreen', animation: 'fade',
    layers: [
      { id: 'bg',    type: 'background', name: 'Background', visible: true, fill: 'solid', color: '#000000', opacity: 100, color2: '#1a1a2e', angle: 160 },
      { id: 'verse', type: 'text', name: 'Verse Text', visible: true, binding: 'verse', customText: '',
        font: { family: 'Manrope', size: 48, weight: 500, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { enabled: false, color: '#000000', width: 2 } },
      { id: 'ref',   type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        font: { family: 'Manrope', size: 22, weight: 600, italic: false, lineHeight: 1.2, letterSpacing: 3, transform: 'uppercase' },
        color: '#ffffff', opacity: 55, align: 'center',
        shadow: { enabled: false, color: '#000000', opacity: 70, blur: 4, x: 0, y: 1 },
        outline: { enabled: false, color: '#000000', width: 1 } },
    ],
  },
  {
    id: 'lower-third', name: 'Lower Third', layout: 'lower-third', animation: 'slide-up',
    layers: [
      { id: 'bg',    type: 'background', name: 'Background', visible: true, fill: 'blur', color: '#000000', opacity: 85, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Verse Text', visible: true, binding: 'verse', customText: '',
        font: { family: 'Manrope', size: 36, weight: 500, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { enabled: false, color: '#000000', opacity: 70, blur: 4, x: 0, y: 1 },
        outline: { enabled: false, color: '#000000', width: 1 } },
      { id: 'ref',   type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        font: { family: 'Manrope', size: 18, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 60, align: 'left',
        shadow: { enabled: false, color: '#000000', opacity: 70, blur: 4, x: 0, y: 1 },
        outline: { enabled: false, color: '#000000', width: 1 } },
    ],
  },
  {
    id: 'no-bg', name: 'No Background', layout: 'fullscreen', animation: 'fade',
    layers: [
      { id: 'bg',    type: 'background', name: 'Background', visible: true, fill: 'transparent', color: '#000000', opacity: 0, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Verse Text', visible: true, binding: 'verse', customText: '',
        font: { family: 'Manrope', size: 52, weight: 700, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 90, blur: 16, x: 0, y: 4 },
        outline: { enabled: false, color: '#000000', width: 2 } },
      { id: 'ref',   type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        font: { family: 'Manrope', size: 20, weight: 600, italic: false, lineHeight: 1.2, letterSpacing: 3, transform: 'uppercase' },
        color: '#ffffff', opacity: 70, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 8, x: 0, y: 2 },
        outline: { enabled: false, color: '#000000', width: 1 } },
    ],
  },
];

let looks       = JSON.parse(localStorage.getItem('kairo-looks-v2') || 'null') || DEFAULT_LOOKS;
let activeLook  = looks[0];
let activeLayer = null; // currently selected layer object

function saveLooks() { localStorage.setItem('kairo-looks-v2', JSON.stringify(looks)); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// ── Hex ↔ rgba helpers ────────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return { r, g, b };
}
function hexOpacity(hex, opacity) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${(opacity/100).toFixed(2)})`;
}

// ── Render themes list ────────────────────────────────────────────────────
function renderLooksList() {
  const el = document.getElementById('looks-list');
  if (!el) return;
  el.innerHTML = '';
  looks.forEach(look => {
    const item = document.createElement('div');
    item.className = 'ts-theme-item' + (look.id === activeLook?.id ? ' active' : '');
    item.innerHTML = `<div class="ts-theme-dot"></div><span>${look.name}</span>`;
    item.addEventListener('click', () => {
      activeLook  = look;
      activeLayer = null;
      renderLooksList();
      renderLayersList();
      syncMetaRow();
      renderPreview();
      renderProps();
    });
    el.appendChild(item);
  });
}

// ── Sync layout + animation + name row ───────────────────────────────────
function syncMetaRow() {
  if (!activeLook) return;
  document.querySelectorAll('#ts-layout-picker .ts-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.layout === activeLook.layout));
  document.querySelectorAll('#ts-anim-picker .ts-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.anim === activeLook.animation));
  const ni = document.getElementById('look-name-input');
  if (ni) ni.value = activeLook.name;
}

// ── Render layers list ────────────────────────────────────────────────────
function renderLayersList() {
  const el = document.getElementById('ts-layers-list');
  if (!el) return;
  el.innerHTML = '';
  if (!activeLook) return;
  // Render in reverse so background is at bottom visually (like PP)
  const rev = [...activeLook.layers].reverse();
  rev.forEach(layer => {
    const row = document.createElement('div');
    row.className = 'ts-layer-row' + (layer.id === activeLayer?.id ? ' active' : '');
    row.dataset.layerId = layer.id;

    const isText = layer.type === 'text';
    const isBg   = layer.type === 'background';

    // Visibility icon
    const visBtn = document.createElement('button');
    visBtn.className = 'ts-layer-vis' + (layer.visible ? '' : ' hidden');
    visBtn.title = layer.visible ? 'Hide' : 'Show';
    visBtn.innerHTML = layer.visible
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    visBtn.addEventListener('click', e => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      renderLayersList();
      renderPreview();
    });

    // Type icon
    const typeIcon = document.createElement('div');
    typeIcon.className = 'ts-layer-type-icon';
    typeIcon.textContent = isBg ? '■' : 'T';

    // Name
    const name = document.createElement('div');
    name.className = 'ts-layer-name';
    name.textContent = layer.name;

    // Delete (text layers only)
    const delBtn = document.createElement('button');
    delBtn.className = 'ts-layer-del';
    delBtn.title = 'Delete layer';
    delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    if (isBg) delBtn.style.display = 'none';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (isBg) return;
      activeLook.layers = activeLook.layers.filter(l => l.id !== layer.id);
      if (activeLayer?.id === layer.id) activeLayer = null;
      renderLayersList();
      renderPreview();
      renderProps();
    });

    row.appendChild(visBtn);
    row.appendChild(typeIcon);
    row.appendChild(name);
    row.appendChild(delBtn);

    row.addEventListener('click', () => {
      activeLayer = layer;
      renderLayersList();
      renderProps();
    });

    el.appendChild(row);
  });
}

// ── Render preview ────────────────────────────────────────────────────────
const PREVIEW_TEXT_SAMPLE = 'For God so loved the world, that he gave his only begotten Son.';
const PREVIEW_REF_SAMPLE  = 'John 3:16 (KJV)';
const SCALE = 0.14; // preview is ~14% of full display size

function layerTextContent(layer) {
  if (layer.binding === 'verse')     return PREVIEW_TEXT_SAMPLE;
  if (layer.binding === 'reference') return PREVIEW_REF_SAMPLE;
  return layer.customText || '[Custom Text]';
}

function renderPreview() {
  const stage = document.getElementById('looks-preview-stage');
  if (!stage || !activeLook) return;

  stage.innerHTML = '';
  stage.className = 'ts-preview-stage';

  const layout = activeLook.layout;

  activeLook.layers.forEach(layer => {
    if (!layer.visible) return;

    if (layer.type === 'background') {
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;inset:0;';

      if (layer.fill === 'transparent') {
        stage.classList.add('ts-transparent-bg');
        return;
      }
      if (layer.fill === 'solid') {
        div.style.background = hexOpacity(layer.color, layer.opacity);
      } else if (layer.fill === 'gradient') {
        const c1 = hexOpacity(layer.color, layer.opacity);
        const c2 = hexOpacity(layer.color2, layer.opacity);
        div.style.background = `linear-gradient(${layer.angle}deg, ${c1}, ${c2})`;
      } else if (layer.fill === 'blur') {
        div.style.background = hexOpacity(layer.color, layer.opacity);
        div.style.backdropFilter = 'blur(8px)';
        // For lower-third, only cover bottom portion
        if (layout === 'lower-third') {
          div.style.inset = 'auto 0 0 0';
          div.style.height = '38%';
        } else if (layout === 'ticker') {
          div.style.inset = 'auto 0 0 0';
          div.style.height = '18%';
        }
      }

      // Lower-third: bg only covers bottom strip
      if ((layout === 'lower-third' || layout === 'ticker') && layer.fill !== 'blur') {
        div.style.inset = 'auto 0 0 0';
        div.style.height = layout === 'ticker' ? '18%' : '38%';
      }

      stage.appendChild(div);
      return;
    }

    if (layer.type === 'text') {
      const div = document.createElement('div');
      div.style.cssText = `
        position: absolute;
        color: ${hexOpacity(layer.color, layer.opacity)};
        font-family: '${layer.font.family}', system-ui, sans-serif;
        font-size: ${(layer.font.size * SCALE).toFixed(1)}px;
        font-weight: ${layer.font.weight};
        font-style: ${layer.font.italic ? 'italic' : 'normal'};
        line-height: ${layer.font.lineHeight};
        letter-spacing: ${(layer.font.letterSpacing * SCALE * 0.5).toFixed(2)}px;
        text-transform: ${layer.font.transform};
        text-align: ${layer.align};
        padding: ${layout === 'fullscreen' ? '8%' : '3% 5%'};
      `;

      // Shadow
      if (layer.shadow.enabled) {
        const sc = hexOpacity(layer.shadow.color, layer.shadow.opacity);
        div.style.textShadow = `${layer.shadow.x}px ${(layer.shadow.y * SCALE).toFixed(1)}px ${(layer.shadow.blur * SCALE).toFixed(1)}px ${sc}`;
      }

      // Position based on layout and binding
      if (layout === 'fullscreen') {
        // Stack verse + ref centered
        div.style.left = '0'; div.style.right = '0';
        if (layer.binding === 'verse')     { div.style.top = '50%'; div.style.transform = 'translateY(-60%)'; }
        if (layer.binding === 'reference') { div.style.top = '50%'; div.style.transform = 'translateY(20%)'; }
        if (layer.align === 'left') { div.style.textAlign = 'left'; }
      } else if (layout === 'lower-third') {
        div.style.left = '0'; div.style.right = '0'; div.style.bottom = '0';
        if (layer.binding === 'verse')     { div.style.bottom = '10%'; }
        if (layer.binding === 'reference') { div.style.bottom = '3%'; }
        div.style.padding = '0 5%';
      } else if (layout === 'ticker') {
        div.style.left = '0'; div.style.right = '0'; div.style.bottom = '2%';
        div.style.whiteSpace = 'nowrap';
        div.style.overflow = 'hidden';
        div.style.textOverflow = 'ellipsis';
        div.style.padding = '0 3%';
      }

      div.textContent = layerTextContent(layer);
      stage.appendChild(div);

      // Load font
      if (layer.font.family !== 'system-ui') loadGoogleFont(layer.font.family);
    }
  });
}

// ── Render properties panel ───────────────────────────────────────────────
function renderProps() {
  const empty = document.getElementById('ts-props-empty');
  const panel = document.getElementById('ts-props-panel');
  if (!panel || !empty) return;

  if (!activeLayer) {
    empty.style.display = 'flex';
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  panel.style.display = 'block';
  panel.innerHTML = '';

  if (activeLayer.type === 'background') {
    renderBgProps(panel, activeLayer);
  } else {
    renderTextProps(panel, activeLayer);
  }
}

function prop(label, content) {
  const row = document.createElement('div');
  row.className = 'ts-prop-row';
  const lbl = document.createElement('span');
  lbl.className = 'ts-prop-label';
  lbl.textContent = label;
  row.appendChild(lbl);
  row.appendChild(content);
  return row;
}

function section(label, ...children) {
  const s = document.createElement('div');
  s.className = 'ts-props-section';
  if (label) {
    const l = document.createElement('div');
    l.className = 'ts-props-section-label';
    l.textContent = label;
    s.appendChild(l);
  }
  children.forEach(c => s.appendChild(c));
  return s;
}

function makeToggle(checked, onChange) {
  const label = document.createElement('label');
  label.className = 'ts-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  const track = document.createElement('span');
  track.className = 'ts-toggle-track';
  label.appendChild(cb);
  label.appendChild(track);
  return label;
}

function makeNumber(val, min, max, step, onChange) {
  const inp = document.createElement('input');
  inp.type = 'number'; inp.className = 'ts-prop-number';
  inp.value = val; inp.min = min; inp.max = max; inp.step = step || 1;
  inp.addEventListener('input', () => onChange(parseFloat(inp.value) || 0));
  return inp;
}

function makeColor(val, onChange) {
  const inp = document.createElement('input');
  inp.type = 'color'; inp.className = 'ts-prop-color';
  inp.value = val;
  inp.addEventListener('input', () => onChange(inp.value));
  return inp;
}

function makeSlider(val, min, max, onChange) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;';
  const sl = document.createElement('input');
  sl.type = 'range'; sl.className = 'ts-prop-slider';
  sl.min = min; sl.max = max; sl.value = val;
  const lbl = document.createElement('span');
  lbl.className = 'ts-prop-val';
  lbl.textContent = val;
  sl.addEventListener('input', () => { lbl.textContent = sl.value; onChange(parseFloat(sl.value)); });
  wrap.appendChild(sl); wrap.appendChild(lbl);
  return wrap;
}

function makeFillChips(current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-fill-group';
  ['solid','transparent','blur','gradient'].forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'ts-fill-chip' + (current === f ? ' active' : '');
    btn.textContent = f.charAt(0).toUpperCase() + f.slice(1);
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.ts-fill-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(f);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function makeAlignBtns(current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-align-group';
  [
    { v: 'left',   icon: '<line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/>' },
    { v: 'center', icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>' },
    { v: 'right',  icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/>' },
  ].forEach(({ v, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'ts-align-btn' + (current === v ? ' active' : '');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${icon}</svg>`;
    btn.title = v;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.ts-align-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(v);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function makeFontSelect(current, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ts-font-select';
  FONTS.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.value;
    opt.textContent = f.label;
    opt.style.fontFamily = f.value;
    if (f.value === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const fam = sel.value;
    if (fam !== 'system-ui') loadGoogleFont(fam);
    onChange(fam);
  });
  return sel;
}

function makeChips(options, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-chip-group';
  wrap.style.cssText = 'flex:1;';
  options.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.className = 'ts-chip' + (current === value ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.ts-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(value);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function up() { renderPreview(); renderLayersList(); }

// Background layer properties
function renderBgProps(panel, layer) {
  // Fill type
  panel.appendChild(section('Fill',
    makeFillChips(layer.fill, v => { layer.fill = v; colorRow.style.display = v === 'transparent' ? 'none' : ''; grad2Row.style.display = v === 'gradient' ? '' : 'none'; up(); })
  ));

  // Color + opacity
  const colorRow = section('Color',
    prop('Color', makeColor(layer.color, v => { layer.color = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity, 0, 100, v => { layer.opacity = v; up(); }))
  );
  if (layer.fill === 'transparent') colorRow.style.display = 'none';
  panel.appendChild(colorRow);

  // Gradient color 2
  const grad2Row = section('Gradient',
    prop('Color 2', makeColor(layer.color2 || '#1a1a2e', v => { layer.color2 = v; up(); })),
    prop('Angle', makeNumber(layer.angle || 160, 0, 360, 5, v => { layer.angle = v; up(); }))
  );
  if (layer.fill !== 'gradient') grad2Row.style.display = 'none';
  panel.appendChild(grad2Row);
}

// Text layer properties
function renderTextProps(panel, layer) {
  // Name + binding
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });

  panel.appendChild(section('Layer',
    prop('Name', nameInp),
    prop('Binds to', makeChips([
      { label: 'Verse', value: 'verse' },
      { label: 'Ref', value: 'reference' },
      { label: 'Custom', value: 'custom' },
    ], layer.binding, v => { layer.binding = v; customRow.style.display = v === 'custom' ? '' : 'none'; up(); }))
  ));

  const customInp = document.createElement('input');
  customInp.type = 'text'; customInp.className = 'ts-prop-input';
  customInp.value = layer.customText || ''; customInp.placeholder = 'Custom text…';
  customInp.addEventListener('input', () => { layer.customText = customInp.value; up(); });
  const customRow = section(null, prop('Text', customInp));
  customRow.style.display = layer.binding === 'custom' ? '' : 'none';
  panel.appendChild(customRow);

  // Font
  panel.appendChild(section('Font',
    prop('Family', makeFontSelect(layer.font.family, v => { layer.font.family = v; up(); })),
    (() => {
      const row = document.createElement('div');
      row.className = 'ts-prop-row';
      row.style.gap = '8px';
      const szLabel = document.createElement('span'); szLabel.className = 'ts-prop-label'; szLabel.textContent = 'Size';
      const szInp = makeNumber(layer.font.size, 8, 300, 1, v => { layer.font.size = v; up(); });
      const wtLabel = document.createElement('span'); wtLabel.className = 'ts-prop-label'; wtLabel.textContent = 'Weight';
      const wtInp = makeNumber(layer.font.weight, 100, 900, 100, v => { layer.font.weight = v; up(); });
      row.appendChild(szLabel); row.appendChild(szInp);
      row.appendChild(wtLabel); row.appendChild(wtInp);
      return row;
    })(),
    (() => {
      const row = document.createElement('div');
      row.className = 'ts-prop-row'; row.style.gap = '8px';
      const itLabel = document.createElement('span'); itLabel.className = 'ts-prop-label'; itLabel.textContent = 'Italic';
      const itToggle = makeToggle(layer.font.italic, v => { layer.font.italic = v; up(); });
      const trLabel = document.createElement('span'); trLabel.className = 'ts-prop-label'; trLabel.style.marginLeft = '8px'; trLabel.textContent = 'Case';
      const trChips = makeChips([
        {label:'None',value:'none'},{label:'Upper',value:'uppercase'},{label:'Lower',value:'lowercase'}
      ], layer.font.transform, v => { layer.font.transform = v; up(); });
      row.appendChild(itLabel); row.appendChild(itToggle);
      row.appendChild(trLabel); row.appendChild(trChips);
      return row;
    })()
  ));

  // Spacing
  panel.appendChild(section('Spacing',
    prop('Line H', makeSlider(layer.font.lineHeight, 0.8, 3, v => { layer.font.lineHeight = parseFloat(v.toFixed(2)); up(); })),
    prop('Letter', makeSlider(layer.font.letterSpacing, -5, 30, v => { layer.font.letterSpacing = parseFloat(v.toFixed(1)); up(); }))
  ));

  // Color
  panel.appendChild(section('Color',
    prop('Color', makeColor(layer.color, v => { layer.color = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity, 0, 100, v => { layer.opacity = v; up(); })),
    prop('Align', makeAlignBtns(layer.align, v => { layer.align = v; up(); }))
  ));

  // Shadow
  const shadowDetails = section(null,
    prop('Color', makeColor(layer.shadow.color, v => { layer.shadow.color = v; up(); })),
    prop('Opacity', makeSlider(layer.shadow.opacity, 0, 100, v => { layer.shadow.opacity = v; up(); })),
    prop('Blur', makeSlider(layer.shadow.blur, 0, 60, v => { layer.shadow.blur = v; up(); })),
    (() => {
      const row = document.createElement('div'); row.className = 'ts-prop-row'; row.style.gap = '8px';
      const xl = document.createElement('span'); xl.className = 'ts-prop-label'; xl.textContent = 'X';
      const yl = document.createElement('span'); yl.className = 'ts-prop-label'; yl.textContent = 'Y';
      const xi = makeNumber(layer.shadow.x, -50, 50, 1, v => { layer.shadow.x = v; up(); });
      const yi = makeNumber(layer.shadow.y, -50, 50, 1, v => { layer.shadow.y = v; up(); });
      row.appendChild(xl); row.appendChild(xi); row.appendChild(yl); row.appendChild(yi);
      return row;
    })()
  );
  shadowDetails.style.display = layer.shadow.enabled ? '' : 'none';

  const shadowHeader = document.createElement('div');
  shadowHeader.className = 'ts-prop-row';
  const shLabel = document.createElement('span'); shLabel.className = 'ts-prop-label'; shLabel.textContent = 'Shadow';
  const shToggle = makeToggle(layer.shadow.enabled, v => { layer.shadow.enabled = v; shadowDetails.style.display = v ? '' : 'none'; up(); });
  shadowHeader.appendChild(shLabel); shadowHeader.appendChild(shToggle);
  const shadowSection = section('Shadow', shadowHeader);
  panel.appendChild(shadowSection);
  panel.appendChild(shadowDetails);

  // Outline
  const outlineDetails = section(null,
    prop('Color', makeColor(layer.outline.color, v => { layer.outline.color = v; up(); })),
    prop('Width', makeSlider(layer.outline.width, 1, 10, v => { layer.outline.width = v; up(); }))
  );
  outlineDetails.style.display = layer.outline.enabled ? '' : 'none';

  const outlineHeader = document.createElement('div');
  outlineHeader.className = 'ts-prop-row';
  const olLabel = document.createElement('span'); olLabel.className = 'ts-prop-label'; olLabel.textContent = 'Outline';
  const olToggle = makeToggle(layer.outline.enabled, v => { layer.outline.enabled = v; outlineDetails.style.display = v ? '' : 'none'; up(); });
  outlineHeader.appendChild(olLabel); outlineHeader.appendChild(olToggle);
  panel.appendChild(section('Outline', outlineHeader));
  panel.appendChild(outlineDetails);
}

// ── Wire modal open/close ─────────────────────────────────────────────────
const looksBtn     = document.getElementById('looks-btn');
const looksModal   = document.getElementById('looks-modal');
const closeLooksBtn = document.getElementById('close-looks');
const newLookBtn   = document.getElementById('new-look-btn');
const saveLookBtn  = document.getElementById('save-look-btn');
const applyLookBtn = document.getElementById('apply-look-btn');
const deleteLookBtn = document.getElementById('delete-look-btn');
const tsAddLayerBtn = document.getElementById('ts-add-layer-btn');

looksBtn?.addEventListener('click', () => {
  looksModal?.classList.remove('hidden');
  renderLooksList();
  renderLayersList();
  syncMetaRow();
  renderPreview();
  renderProps();
});

closeLooksBtn?.addEventListener('click', () => looksModal?.classList.add('hidden'));
looksModal?.querySelector('.modal-overlay')?.addEventListener('click', () => looksModal?.classList.add('hidden'));

// Layout chips
document.getElementById('ts-layout-picker')?.addEventListener('click', e => {
  const btn = e.target.closest('.ts-chip');
  if (!btn || !activeLook) return;
  document.querySelectorAll('#ts-layout-picker .ts-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeLook.layout = btn.dataset.layout;
  renderPreview();
});

// Animation chips
document.getElementById('ts-anim-picker')?.addEventListener('click', e => {
  const btn = e.target.closest('.ts-chip');
  if (!btn || !activeLook) return;
  document.querySelectorAll('#ts-anim-picker .ts-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeLook.animation = btn.dataset.anim;
});

// Name input
document.getElementById('look-name-input')?.addEventListener('input', e => {
  if (activeLook) { activeLook.name = e.target.value; renderLooksList(); }
});

// Add text layer
tsAddLayerBtn?.addEventListener('click', () => {
  if (!activeLook) return;
  const id = 'layer-' + Date.now();
  const newLayer = {
    id, type: 'text', name: 'Text', visible: true,
    binding: 'custom', customText: 'New text layer',
    font: { family: 'Manrope', size: 36, weight: 500, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
    color: '#ffffff', opacity: 100, align: 'center',
    shadow: { enabled: false, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
    outline: { enabled: false, color: '#000000', width: 2 },
  };
  activeLook.layers.push(newLayer);
  activeLayer = newLayer;
  renderLayersList();
  renderPreview();
  renderProps();
});

// Save
saveLookBtn?.addEventListener('click', () => {
  if (!activeLook) return;
  const idx = looks.findIndex(l => l.id === activeLook.id);
  if (idx >= 0) looks[idx] = activeLook;
  else looks.push(activeLook);
  saveLooks();
  renderLooksList();
  toast('Theme saved', 'success');
});

// New theme
newLookBtn?.addEventListener('click', () => {
  const base = deepClone(DEFAULT_LOOKS[0]);
  base.id   = 'look-' + Date.now();
  base.name = 'New Theme';
  looks.push(base);
  activeLook  = base;
  activeLayer = null;
  saveLooks();
  renderLooksList();
  renderLayersList();
  syncMetaRow();
  renderPreview();
  renderProps();
  document.getElementById('look-name-input')?.focus();
});

// Delete
deleteLookBtn?.addEventListener('click', () => {
  if (looks.length <= 1) { toast('Cannot delete the last theme', 'error'); return; }
  looks = looks.filter(l => l.id !== activeLook?.id);
  activeLook  = looks[0];
  activeLayer = null;
  saveLooks();
  renderLooksList();
  renderLayersList();
  syncMetaRow();
  renderPreview();
  renderProps();
  toast('Theme deleted', 'success');
});

// Apply to outputs — broadcasts look JSON to display.html via localStorage + WebSocket
applyLookBtn?.addEventListener('click', async () => {
  if (!activeLook) return;

  // 1. localStorage → same-origin display windows pick it up via storage event
  localStorage.setItem('kairo-active-look', JSON.stringify(activeLook));
  localStorage.setItem('kairo-active-look-ts', Date.now().toString());

  // 2. WebSocket broadcast → all display clients on any origin update immediately
  try {
    await fetch(`${SERVER}/api/look/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ look: activeLook }),
    });
  } catch (err) {
    console.warn('[Look] WS broadcast failed:', err.message);
  }

  toast('Theme applied to all outputs', 'success');
});

// ── Auto-update listener (Tauri only) ─────────────────────────────────────
// The Rust side emits `update-available` after a background check on startup.
// We show a dismissible banner; clicking it calls install_update() in Rust,
// which downloads the package and restarts the app.
(function initUpdater() {
  if (!window.__TAURI__) return; // not running inside Tauri shell

  window.__TAURI__.event.listen('update-available', (event) => {
    const { version, notes } = event.payload || {};
    showUpdateBanner(version, notes);
  });

  function showUpdateBanner(version, notes) {
    const existing = document.getElementById('update-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
        <polyline points="21 16 21 21 16 21"/><line x1="15" y1="4" x2="21" y2="10"/>
      </svg>
      <span>KAIRO <strong>${version || 'update'}</strong> is available${notes ? ' — ' + notes.split('\n')[0] : ''}.</span>
      <button class="upd-btn" id="upd-install-btn">Update &amp; Restart</button>
      <button class="upd-snooze" id="upd-snooze-btn" aria-label="Dismiss">Later</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);

    document.getElementById('upd-install-btn').addEventListener('click', async () => {
      document.getElementById('upd-install-btn').textContent = 'Downloading…';
      document.getElementById('upd-install-btn').disabled = true;
      try {
        await window.__TAURI__.core.invoke('install_update');
      } catch (e) {
        toast('Update failed: ' + e, 'error');
        banner.remove();
      }
    });

    document.getElementById('upd-snooze-btn').addEventListener('click', () => banner.remove());
  }
})();

// Init
renderLooksList();
connectWS();
