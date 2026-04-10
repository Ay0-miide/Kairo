#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# KAIRO release setup — run once before pushing your first release.
#
# What this does:
#   1. Asks for your GitHub username and patches all placeholder URLs
#   2. Uploads TAURI_SIGNING_PRIVATE_KEY to GitHub Actions secrets via gh CLI
#   3. Reminds you about optional Apple code-signing secrets
#
# Requirements:
#   - GitHub CLI (gh) installed and authenticated: brew install gh && gh auth login
#   - The signing keypair at /tmp/kairo-updater.key (already generated)
#     If it doesn't exist, run: npx @tauri-apps/cli signer generate -p "" -w /tmp/kairo-updater.key
# ─────────────────────────────────────────────────────────────────────────────

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. GitHub username ────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║        KAIRO — Release Setup               ║"
echo "╚════════════════════════════════════════════╝"
echo ""

read -rp "Enter your GitHub username: " GH_USER
if [ -z "$GH_USER" ]; then
  echo "❌ GitHub username required."; exit 1
fi

REPO_SLUG="$GH_USER/KAIRO"

echo ""
echo "→ Patching repo URLs to: $REPO_SLUG"

# Patch tauri.conf.json updater endpoint
sed -i.bak "s|YOUR_GITHUB_USERNAME/KAIRO|$REPO_SLUG|g" \
  src-tauri/tauri.conf.json && rm -f src-tauri/tauri.conf.json.bak

# Patch landing page
sed -i.bak "s|YOUR_GITHUB_USERNAME/KAIRO|$REPO_SLUG|g" \
  docs/index.html && rm -f docs/index.html.bak

echo "✓ URLs patched"

# ── 2. Upload signing key to GitHub secrets ───────────────────────────────────
KEY_FILE="/tmp/kairo-updater.key"
if [ ! -f "$KEY_FILE" ]; then
  echo ""
  echo "⚠  Signing key not found at $KEY_FILE"
  echo "   Run this first:"
  echo "   npx @tauri-apps/cli signer generate -p \"\" -w /tmp/kairo-updater.key"
  echo ""
  echo "   Then re-run this script."
  exit 1
fi

echo ""
echo "→ Uploading TAURI_SIGNING_PRIVATE_KEY to GitHub secrets…"

if ! command -v gh &>/dev/null; then
  echo "❌ GitHub CLI (gh) not found."
  echo "   Install it: brew install gh   then:  gh auth login"
  echo ""
  echo "   Alternatively, set this secret manually in:"
  echo "   https://github.com/$REPO_SLUG/settings/secrets/actions"
  echo ""
  echo "   Secret name:  TAURI_SIGNING_PRIVATE_KEY"
  echo "   Secret value: $(cat $KEY_FILE)"
  echo ""
  echo "   Secret name:  TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
  echo "   Secret value: (leave empty — key was generated with no password)"
else
  gh secret set TAURI_SIGNING_PRIVATE_KEY \
    --repo "$REPO_SLUG" \
    --body "$(cat $KEY_FILE)"

  gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    --repo "$REPO_SLUG" \
    --body ""

  echo "✓ Signing secrets uploaded"
fi

# ── 3. Apple notarization reminder ───────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────────────────"
echo "  Optional: macOS notarization (removes 'unidentified developer'"
echo "  warning on first launch)"
echo ""
echo "  Requires an Apple Developer account (\$99/yr)."
echo "  Add these secrets at:"
echo "  https://github.com/$REPO_SLUG/settings/secrets/actions"
echo ""
echo "    APPLE_CERTIFICATE           — base64 .p12:  base64 -i cert.p12 | pbcopy"
echo "    APPLE_CERTIFICATE_PASSWORD  — .p12 password"
echo "    APPLE_SIGNING_IDENTITY      — 'Developer ID Application: Name (TEAMID)'"
echo "    APPLE_ID                    — your Apple ID email"
echo "    APPLE_PASSWORD              — app-specific password from appleid.apple.com"
echo "    APPLE_TEAM_ID               — 10-char team ID from developer.apple.com"
echo ""
echo "  Skip these if you're distributing internally — users can still"
echo "  install by right-clicking the .dmg and choosing Open."
echo "─────────────────────────────────────────────────────────────────"

# ── 4. GitHub Pages ───────────────────────────────────────────────────────────
echo ""
echo "→ To enable the landing page (kairo.github.io/$GH_USER):"
echo "   1. Push to GitHub"
echo "   2. Go to: https://github.com/$REPO_SLUG/settings/pages"
echo "   3. Source: GitHub Actions"
echo "   (The workflow deploys docs/ automatically on every tagged release)"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Setup complete!"
echo ""
echo "To cut your first release:"
echo "   git tag v2.0.0 && git push origin v2.0.0"
echo ""
echo "GitHub Actions will build installers for macOS (arm64 + x64),"
echo "Windows (.msi), and Linux (.AppImage) and create a draft Release."
echo "Review the draft at: https://github.com/$REPO_SLUG/releases"
echo ""
