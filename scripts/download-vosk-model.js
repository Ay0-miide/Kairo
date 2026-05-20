#!/usr/bin/env node
// Thin CLI wrapper around server/vosk_installer.js. The actual download +
// extraction logic lives in that module so the in-app HTTP installer can
// reuse it. Cross-platform (macOS / Linux / Windows) — no extra npm deps.
//
// Usage:  node scripts/download-vosk-model.js
//   Or:   npm run vosk:install

'use strict';

const { installVoskModel, isModelPresent, modelDir, DOWNLOAD_URL } = require('../server/vosk_installer');

function log(msg) { process.stdout.write(`[vosk] ${msg}\n`); }
function die(msg) { process.stderr.write(`[vosk] ERROR: ${msg}\n`); process.exit(1); }

(async () => {
  if (isModelPresent()) {
    log(`Model already present at ${modelDir()}`);
    return;
  }
  log(`Downloading ${DOWNLOAD_URL} (~40MB)…`);

  // Throttle terminal output to every 5% so the line doesn't flicker.
  let lastPrinted = -1;
  let extractedNoted = false;
  try {
    await installVoskModel({
      onProgress: (e) => {
        if (e.phase === 'download' && e.pct % 5 === 0 && e.pct !== lastPrinted) {
          process.stdout.write(`\r[vosk] Downloading… ${e.pct}%`);
          lastPrinted = e.pct;
        } else if (e.phase === 'extract' && !extractedNoted) {
          extractedNoted = true;
          process.stdout.write('\n[vosk] Extracting…\n');
        } else if (e.phase === 'done') {
          log(`Done. Model installed at ${e.modelDir}`);
        }
      },
    });
  } catch (err) {
    die(err.message || String(err));
  }
})();
