#!/usr/bin/env node
// Downloads the Vosk small English model used by Kairo's offline speech engine.
// Cross-platform replacement for the old bash script — runs on macOS, Linux,
// and Windows with no extra dependencies (uses Node's built-in https + the
// system `tar` for extraction, which ships on Windows 10 1803+ as well as
// every modern macOS/Linux).
//
// Idempotent: prints a notice and exits 0 if the model is already present.
// Streams a percentage to stdout so the npm script gives the user feedback.
//
// Usage:  node scripts/download-vosk-model.js
//   Or:   npm run vosk:install

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const REPO_ROOT      = path.resolve(__dirname, '..');
const MODELS_DIR     = path.join(REPO_ROOT, 'server', 'models');
const MODEL_DIR      = path.join(MODELS_DIR, 'vosk-en');
const MODEL_CONF     = path.join(MODEL_DIR, 'conf', 'model.conf');
const ZIP_NAME       = 'vosk-model-small-en-us-0.15.zip';
const EXTRACTED_NAME = 'vosk-model-small-en-us-0.15';
const URL            = `https://alphacephei.com/vosk/models/${ZIP_NAME}`;

function log(msg) { process.stdout.write(`[vosk] ${msg}\n`); }
function die(msg) { process.stderr.write(`[vosk] ERROR: ${msg}\n`); process.exit(1); }

if (fs.existsSync(MODEL_CONF)) {
  log(`Model already present at ${MODEL_DIR}`);
  process.exit(0);
}

fs.mkdirSync(MODELS_DIR, { recursive: true });
const zipPath = path.join(MODELS_DIR, ZIP_NAME);

// Stream the zip to disk, printing a rolling percentage so the user sees
// progress instead of staring at a silent terminal for 30+ seconds.
// Follows one level of HTTP redirect (alphacephei serves 200 directly, but
// guarding against this is cheap and makes the script robust to mirrors).
function download(url, dest, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        fs.unlinkSync(dest);
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return download(res.headers.location, dest, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct  = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            process.stdout.write(`\r[vosk] Downloading… ${pct}%`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        process.stdout.write('\r[vosk] Downloading… 100%\n');
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

// `tar` on Windows 10 1803+ / macOS / Linux all understand zip via `-xf`.
// If it's missing (rare modern system), fall back to `unzip` on POSIX or
// PowerShell `Expand-Archive` on Windows — both are universally available
// on their respective OSes.
function extract(zip, destDir) {
  const tries = [];
  tries.push({ cmd: 'tar', args: ['-xf', zip, '-C', destDir] });
  if (process.platform === 'win32') {
    tries.push({
      cmd:  'powershell',
      args: ['-NoProfile', '-Command',
             `Expand-Archive -Force -Path '${zip}' -DestinationPath '${destDir}'`],
    });
  } else {
    tries.push({ cmd: 'unzip', args: ['-q', '-o', zip, '-d', destDir] });
  }
  for (const { cmd, args } of tries) {
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status === 0) return;
    if (r.error && r.error.code !== 'ENOENT') {
      die(`Extraction failed (${cmd}): ${r.error.message}`);
    }
  }
  die('Could not extract the archive — install `tar` or `unzip` and retry.');
}

(async () => {
  try {
    log(`Downloading ${URL} (~40MB)…`);
    await download(URL, zipPath);

    log('Extracting…');
    extract(zipPath, MODELS_DIR);
    try { fs.unlinkSync(zipPath); } catch {}

    // Normalise directory name so server.js doesn't have to track versions.
    const extractedPath = path.join(MODELS_DIR, EXTRACTED_NAME);
    if (fs.existsSync(extractedPath) && !fs.existsSync(MODEL_DIR)) {
      fs.renameSync(extractedPath, MODEL_DIR);
    }

    if (!fs.existsSync(MODEL_CONF)) {
      die(`Extraction completed but ${MODEL_CONF} is missing. The downloaded archive may be corrupted.`);
    }
    log(`Done. Model installed at ${MODEL_DIR}`);
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch {}
    die(err.message || String(err));
  }
})();
