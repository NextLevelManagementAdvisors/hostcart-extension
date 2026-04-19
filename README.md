# Hostcart Connector — Browser Extension

Manifest V3 Chromium extension that captures the user's Instacart and Turno session credentials and ships them to `hostcart.nlma.io` so the Hostcart server can act on the user's behalf for replenishment.

## What it does

1. **Pair once**: user pastes a 6-digit code from `hostcart.nlma.io/settings/extension` into the popup; extension stores the resulting long-lived `extension_token`.
2. **Auto-capture**: listens on `chrome.cookies.onChanged` for instacart.com and app.turnoverbnb.com — whenever the session cookie rotates (i.e. the user logs in or refreshes naturally), the extension uploads the new cookie to `/api/sessions/capture`. Content scripts also forward localStorage auth tokens.
3. **Heartbeat**: every 6 hours the background service worker pings each service's status endpoint with `credentials: include` to keep cookies warm even when the user never visits the site.
4. **Proactive reauth**: every 6 hours fetches `/api/sessions` from Hostcart and shows a Chrome notification when any service has been idle >25 days.

Phase 2 (Instacart Connect partner approval) replaces this whole flow with OAuth and the extension is sunset.

## Development install

```
chrome://extensions  →  Developer mode (toggle on)  →  Load unpacked  →  point at extension/
```

The popup icon shows up in the Chrome toolbar; clicking it opens `popup.html`. First install opens `onboarding.html` automatically.

## Building a `.crx` for self-hosted distribution

Hostcart's beta distributes the extension as a self-hosted `.crx` rather than going through the Chrome Web Store. Steps:

1. Bump `version` in `manifest.json`
2. From this directory:
   ```bash
   chrome --pack-extension="$(pwd)" --pack-extension-key="$(pwd)/../.secrets/hostcart-extension.pem"
   ```
   On first build, omit `--pack-extension-key` to generate a fresh key. **Save the generated `.pem` to `.secrets/` (gitignored)** — re-using it across versions is what lets Chrome treat updates as the same extension instead of a new install.
3. Upload `extension.crx` to `https://hostcart.nlma.io/downloads/hostcart-connector-<version>.crx`
4. Update `update_url` field in a future manifest revision if you want auto-update support

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; permissions, host_permissions, scripts |
| `background.js` | Service worker: pairing storage, cookie capture, alarms, notifications |
| `content-instacart.js` | Injected on instacart.com; scrapes localStorage auth tokens |
| `content-turno.js` | Same for app.turnoverbnb.com |
| `popup.html` + `popup.js` | Toolbar dropdown: pairing input or per-service status |
| `onboarding.html` + `onboarding.js` | First-install walkthrough, opened automatically |
| `icons/icon.svg` | Source design |
| `icons/icon-{16,32,48,128}.png` | Placeholder PNG renders (see `icons/generate.mjs`) |

## Server contract

The extension talks to the Hostcart backend on three endpoints:

- `POST /api/extensions/pair` — exchange 6-digit code for `extension_token`
- `POST /api/sessions/capture` — upload service cookies/token; auth via `x-extension-token` header
- `GET /api/sessions` — list sessions per user (used to detect stale connections)

Backend route definitions live in `server/src/routes/sessions.ts` and (pending) `server/src/routes/extensions.ts`.

## Security notes

- The extension never reads credentials before login — it only captures the session token after the user has authenticated themselves
- `extension_token` is opaque and tied to one Hostcart user; revocation invalidates all subsequent capture uploads
- Service cookies are encrypted at rest on the server (AES-GCM, see `server/src/crypto.ts`)
- Users can disconnect at any time via the popup; the next deploy or replenish-cron run will detect the missing session and pause replenishment for that user
