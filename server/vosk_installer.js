// Vosk model installer — shared module used by both the CLI script
// (scripts/download-vosk-model.js) and the in-app HTTP endpoint
// (POST /api/vosk/install). Lives in server/ so it can be required from
// either context without weird relative-path gymnastics.
//
// Exports a single Promise-returning function. Caller hooks `onProgress` to
// see download bytes / extract status streamed in real time — the CLI prints
// percentages, the HTTP endpoint forwards them as NDJSON to the frontend.
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ZIP_NAME       = 'vosk-model-small-en-us-0.15.zip';
const EXTRACTED_NAME = 'vosk-model-small-en-us-0.15';
const DOWNLOAD_URL   = `https://alphacephei.com/vosk/models/${ZIP_NAME}`;

const DEFAULT_MODELS_DIR = path.join(__dirname, 'models');
const MODEL_DIR_NAME     = 'vosk-en';

function modelDir(modelsDir = DEFAULT_MODELS_DIR) {
  return path.join(modelsDir, MODEL_DIR_NAME);
}
function modelConfPath(modelsDir = DEFAULT_MODELS_DIR) {
  return path.join(modelDir(modelsDir), 'conf', 'model.conf');
}
function isModelPresent(modelsDir = DEFAULT_MODELS_DIR) {
  return fs.existsSync(modelConfPath(modelsDir));
}

// Stream the zip to disk. Follows up to `maxRedirects` levels — alphacephei
// serves 200 directly today but mirrors may redirect.
function download(url, dest, onProgress, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return download(res.headers.location, dest, onProgress, maxRedirects - 1)
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct  = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!total) return;
        const pct = Math.floor((received / total) * 100);
        // Emit at every percent so UI feels live; the CLI only prints every
        // 5% to keep terminal output readable.
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.({ phase: 'download', pct, received, total });
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        onProgress?.({ phase: 'download', pct: 100, received: total, total });
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

// `tar` ships on Windows 10 1803+, macOS, and every modern Linux and
// understands zip via `-xf`. Falls back to `unzip` / PowerShell Expand-Archive
// if `tar` is missing.
function extract(zip, destDir) {
  const tries = [{ cmd: 'tar', args: ['-xf', zip, '-C', destDir] }];
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
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0) return;
    if (r.error && r.error.code !== 'ENOENT') {
      throw new Error(`Extraction failed (${cmd}): ${r.error.message}`);
    }
  }
  throw new Error('No archive tool available (tried tar / unzip / PowerShell).');
}

async function installVoskModel({ modelsDir = DEFAULT_MODELS_DIR, onProgress } = {}) {
  if (isModelPresent(modelsDir)) {
    onProgress?.({ phase: 'done', already: true, modelDir: modelDir(modelsDir) });
    return { alreadyPresent: true, modelDir: modelDir(modelsDir) };
  }

  fs.mkdirSync(modelsDir, { recursive: true });
  const zipPath = path.join(modelsDir, ZIP_NAME);

  try {
    onProgress?.({ phase: 'download', pct: 0 });
    await download(DOWNLOAD_URL, zipPath, onProgress);

    onProgress?.({ phase: 'extract' });
    extract(zipPath, modelsDir);
    try { fs.unlinkSync(zipPath); } catch {}

    // Normalise directory name so server.js doesn't have to track Vosk version bumps.
    const extractedPath = path.join(modelsDir, EXTRACTED_NAME);
    const target        = modelDir(modelsDir);
    if (fs.existsSync(extractedPath) && !fs.existsSync(target)) {
      fs.renameSync(extractedPath, target);
    }

    if (!isModelPresent(modelsDir)) {
      throw new Error(`Extraction completed but ${modelConfPath(modelsDir)} is missing — archive may be corrupted.`);
    }

    onProgress?.({ phase: 'done', already: false, modelDir: target });
    return { alreadyPresent: false, modelDir: target };
  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw err;
  }
}

module.exports = {
  installVoskModel,
  isModelPresent,
  modelDir,
  modelConfPath,
  DEFAULT_MODELS_DIR,
  DOWNLOAD_URL,
};
