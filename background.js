const HOSTCART_API = "https://hostcart.nlma.io";

const SERVICES = {
  "instacart.com": {
    name: "instacart",
    cookieName: "_instacart_session_id",
    statusUrl: "https://www.instacart.com/v3/user/status"
  },
  "app.turnoverbnb.com": {
    name: "turno",
    cookieName: "auth_token",
    statusUrl: "https://app.turnoverbnb.com/api/v2/me"
  }
};

function serviceFromDomain(domain) {
  for (const host of Object.keys(SERVICES)) {
    if (domain === host || domain.endsWith("." + host)) return SERVICES[host];
  }
  return null;
}

async function getPairing() {
  const { pairing } = await chrome.storage.local.get("pairing");
  return pairing ?? null;
}

async function savePairing(pairing) {
  await chrome.storage.local.set({ pairing });
}

async function captureCookies(service) {
  const cookies = await chrome.cookies.getAll({ domain: service.cookieName ? undefined : undefined });
  const relevant = await chrome.cookies.getAll({
    domain: Object.keys(SERVICES).find(h => SERVICES[h] === service)
  });
  if (relevant.length === 0) return null;
  return relevant
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
}

async function postSession(service, cookieString) {
  const pairing = await getPairing();
  if (!pairing?.extensionToken) {
    console.log("[hostcart] not paired; skipping upload");
    return;
  }
  try {
    const res = await fetch(`${HOSTCART_API}/api/sessions/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-extension-token": pairing.extensionToken
      },
      body: JSON.stringify({
        service: service.name,
        cookies: cookieString
      })
    });
    if (!res.ok) {
      console.warn(`[hostcart] capture upload failed ${res.status}`);
      if (res.status === 401) {
        await chrome.storage.local.remove("pairing");
      }
      return;
    }
    await chrome.storage.local.set({
      [`lastCapture:${service.name}`]: Date.now()
    });
    console.log(`[hostcart] captured ${service.name}`);
  } catch (err) {
    console.warn(`[hostcart] capture upload error`, err);
  }
}

chrome.cookies.onChanged.addListener(async (info) => {
  if (info.removed) return;
  const service = serviceFromDomain(info.cookie.domain.replace(/^\./, ""));
  if (!service) return;
  if (info.cookie.name !== service.cookieName) return;
  const cookieString = await captureCookies(service);
  if (cookieString) await postSession(service, cookieString);
});

chrome.alarms.create("heartbeat", { periodInMinutes: 360 });
chrome.alarms.create("reauthCheck", { periodInMinutes: 60 * 6 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "heartbeat") await runHeartbeat();
  else if (alarm.name === "reauthCheck") await runReauthCheck();
});

async function runHeartbeat() {
  for (const service of Object.values(SERVICES)) {
    try {
      await fetch(service.statusUrl, { credentials: "include", cache: "no-store" });
    } catch {
      // swallow — heartbeat is best-effort
    }
  }
}

async function runReauthCheck() {
  const pairing = await getPairing();
  if (!pairing?.extensionToken) return;
  let res;
  try {
    res = await fetch(`${HOSTCART_API}/api/sessions`, {
      headers: { "x-extension-token": pairing.extensionToken }
    });
  } catch {
    return;
  }
  if (!res.ok) return;
  const data = await res.json().catch(() => null);
  if (!data?.sessions) return;
  const DAY_MS = 86400000;
  const now = Date.now();
  for (const s of data.sessions) {
    const lastUsed = s.last_used_at ? new Date(s.last_used_at).getTime() : 0;
    const ageDays = (now - lastUsed) / DAY_MS;
    if (ageDays >= 25) {
      notifyReauth(s.service);
    }
  }
}

function notifyReauth(serviceName) {
  chrome.notifications.create(`reauth:${serviceName}:${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Hostcart: refresh your connection",
    message: `Open ${serviceName}.com to refresh your Hostcart connection. Takes ~10 seconds.`,
    priority: 1
  });
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const parts = notificationId.split(":");
  if (parts[0] !== "reauth") return;
  const serviceName = parts[1];
  const url =
    serviceName === "instacart" ? "https://www.instacart.com/"
    : serviceName === "turno" ? "https://app.turnoverbnb.com/"
    : null;
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pair") {
    savePairing(msg.pairing).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "getPairing") {
    getPairing().then((p) => sendResponse({ pairing: p }));
    return true;
  }
  if (msg?.type === "manualCapture") {
    (async () => {
      const service = SERVICES[msg.host];
      if (!service) { sendResponse({ ok: false, error: "unknown host" }); return; }
      const cookieString = await captureCookies(service);
      if (!cookieString) { sendResponse({ ok: false, error: "no cookies" }); return; }
      await postSession(service, cookieString);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "authTokenFromPage") {
    // content-script forwards a localStorage token captured on the page
    (async () => {
      const service = SERVICES[msg.host];
      if (!service) { sendResponse({ ok: false }); return; }
      const pairing = await getPairing();
      if (!pairing?.extensionToken) { sendResponse({ ok: false, error: "not paired" }); return; }
      try {
        await fetch(`${HOSTCART_API}/api/sessions/capture`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-extension-token": pairing.extensionToken
          },
          body: JSON.stringify({ service: service.name, token: msg.token })
        });
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
});
