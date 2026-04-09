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

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(wsReconnectTimer);
    updatePPStatus('Checking…', '');
    loadSettings();
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
  const { verses, method, target, topScore } = msg;
  if (!verses?.length) return;

  if (target === 'viewer' && (topScore == null || topScore >= CLIENT_VIEWER_MIN_SCORE)) {
    showInViewer(verses, method, topScore);
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

function showInViewer(verses, method, topScore) {
  const v = verses[0];

  // Update live preview screen
  if (previewVerseText) previewVerseText.textContent = cleanVerseText(v.text);
  if (previewVerseRef)  previewVerseRef.textContent  = v.reference || '';

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
        const card = buildQueueRow(v, method);
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
function buildQueueRow(v, method) {
  const card = document.createElement('div');
  card.dataset.ref = v.reference;
  card.className = 'locked-verse-card';
  const refParts = (v.reference || '').split(' ');
  const bookAbbr = refParts[0]?.slice(0, 2).toUpperCase() || '??';
  const chapNum  = (refParts[1] || refParts[2] || '').split(':')[0];
  const abbr     = bookAbbr + (chapNum ? '·' + chapNum : '');
  card.innerHTML = `
    <div class="history-book-badge">${abbr}</div>
    <div class="history-card-content">
      <div class="lvc-ref">${v.reference}</div>
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

  // Short book abbreviation for history grid badge: "Matthew 17:21" → "MT·17"
  const refParts = (v.reference || '').split(' ');
  const bookAbbr = refParts[0]?.slice(0, 2).toUpperCase() || '??';
  const chapNum  = (refParts[1] || refParts[2] || '').split(':')[0];
  const abbr     = bookAbbr + (chapNum ? '·' + chapNum : '');

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
    card.innerHTML = `
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

  const refParts = (v.reference || '').split(' ');
  const bookAbbr = refParts[0]?.slice(0, 2).toUpperCase() || '??';
  const chapNum  = (refParts[1] || '').split(':')[0];
  const abbr     = bookAbbr + (chapNum ? '·' + chapNum : '');

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
  await fetch(`${SERVER}/api/stop-listening`, { method: 'POST' }).catch(() => {});
  stopAudioCapture();
  clearInterval(elapsedInterval);
}

function stopAudioCapture() {
  if (audioProcessor) { try { audioProcessor.disconnect(); } catch {} audioProcessor = null; }
  if (audioContext)   { try { audioContext.close(); }       catch {} audioContext   = null; }
  if (mediaStream)    { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// ── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const r = await fetch(`${SERVER}/api/settings`);
    settings = await r.json();
    // Populate UI
    if (ppUrlInput && settings.proPresenterUrl) ppUrlInput.value = settings.proPresenterUrl;
    if (translationSettings && settings.translation) translationSettings.value = settings.translation;
    if (translationSelect && settings.translation)   translationSelect.value   = settings.translation;
    if (autoSendCheckbox)  autoSendCheckbox.checked  = settings.autoSend  !== false;
    if (autoSendSettings)  autoSendSettings.checked  = settings.autoSend  !== false;
    if (showConfSettings)  showConfSettings.checked   = settings.showConfidence !== false;
    updatePPTokenLabel();
  } catch {}
}

async function saveCurrentSettings() {
  const updated = {
    deepgramApiKey:    deepgramKeyInput?.value    || settings.deepgramApiKey,
    proPresenterUrl:   ppUrlInput?.value          || 'http://localhost:1025',
    translation:       translationSettings?.value || 'KJV',
    ppSwapTokenOrder:  settings.ppSwapTokenOrder  || false,
    autoSend:          autoSendSettings?.checked  !== false,
    showConfidence:    showConfSettings?.checked   !== false,
  };
  await fetch(`${SERVER}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  settings = { ...settings, ...updated };
  if (translationSelect && updated.translation) translationSelect.value = updated.translation;
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
  await fetch(`${SERVER}/api/propresenter/clear`, { method: 'POST' }).catch(() => {});
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
connectWS();
