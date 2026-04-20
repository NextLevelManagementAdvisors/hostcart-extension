// Bridge between the Hostcart SPA and the extension's background worker.
// Eliminates the 6-digit copy/paste step: the SPA posts a pair code via
// window.postMessage, this content script performs the /api/extensions/pair
// exchange, hands the token to the background worker, and reports success
// back to the SPA. The SPA also uses the probe/present handshake to detect
// whether the extension is installed + paired without resorting to user
// agent sniffing or polling.

const HOSTCART_API = "https://hostcart.nlma.io";
const TRUSTED_ORIGINS = new Set([
  "https://hostcart.nlma.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function reply(type, data, targetOrigin) {
  window.postMessage({ type, ...data }, targetOrigin);
}

async function hasPairing() {
  const { pairing } = await chrome.storage.local.get("pairing");
  return !!pairing?.extensionToken;
}

async function exchangeCode(code) {
  const res = await fetch(`${HOSTCART_API}/api/extensions/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    throw new Error(`pair_${res.status}`);
  }
  return res.json();
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (!TRUSTED_ORIGINS.has(event.origin)) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "hostcart:extension-probe") {
    const paired = await hasPairing();
    reply(
      "hostcart:extension-present",
      {
        paired,
        version: chrome.runtime.getManifest().version,
      },
      event.origin
    );
    return;
  }

  if (msg.type === "hostcart:pair-code" && typeof msg.code === "string") {
    try {
      const data = await exchangeCode(msg.code);
      await chrome.runtime.sendMessage({
        type: "pair",
        pairing: {
          extensionToken: data.extension_token,
          email: data.email,
          userId: data.user_id,
        },
      });
      reply(
        "hostcart:pair-result",
        { ok: true, email: data.email },
        event.origin
      );
    } catch (err) {
      reply(
        "hostcart:pair-result",
        { ok: false, error: err && err.message ? err.message : "pair_failed" },
        event.origin
      );
    }
  }
});
