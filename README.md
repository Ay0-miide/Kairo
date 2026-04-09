# KAIRO

> Real-time scripture detection for live sermons — powered by Deepgram STT + ProPresenter integration.

KAIRO listens to a preacher in real time, detects scripture references from speech, and automatically sends the correct Bible verse to ProPresenter — no manual lookup required.

---

## Features

- **Live speech-to-text** via Deepgram
- **Automatic scripture detection** from natural spoken language (e.g. *"turn to John chapter 3 verse 16"*)
- **Range support** — detects verse ranges and auto-advances through them as the preacher reads
- **ProPresenter integration** — broadcasts detected verses directly to your presentation software
- **Manual search** — look up any scripture by reference or keyword and send it instantly
- **Live queue** — see and manage what's been sent during the service
- **Translation support** — KJV / NLT

---

## Stack

| Layer | Tech |
|-------|------|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust) |
| Frontend | Vanilla JS + HTML/CSS |
| Speech-to-text | [Deepgram](https://deepgram.com) Nova-2 |
| Detection engine | Node.js worker thread |
| Vector search | FAISS + `@xenova/transformers` embeddings |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (for Tauri)
- A [Deepgram API key](https://console.deepgram.com)
- ProPresenter running locally (optional)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/Ay0-miide/Kairo.git
cd Kairo

# 2. Install dependencies
npm install
cd server && npm install && cd ..

# 3. Configure settings
cp databases/settings.example.json databases/settings.json
# Edit databases/settings.json and add your Deepgram API key
```

### Run (development)

```bash
npm run dev
```

### Run server only

```bash
npm run server
```

---

## Configuration

Edit `databases/settings.json`:

```json
{
  "deepgramApiKey": "YOUR_DEEPGRAM_API_KEY",
  "proPresenterUrl": "http://localhost:1025",
  "translation": "KJV",
  "ppSwapTokenOrder": false,
  "autoSend": true,
  "showConfidence": true
}
```

> ⚠️ Never commit `settings.json` — it's gitignored.

---

## License

MIT
