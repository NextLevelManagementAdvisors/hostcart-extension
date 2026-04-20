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

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

chrome.alarms.create("heartbeat", { periodInMinutes: 360 });
chrome.alarms.create("reauthCheck", { periodInMinutes: 60 * 6 });
// Wake the service worker frequently to poll for Instacart proxy work. 1min
// is the MV3 alarm minimum; between wakes the long-poll holds the fetch open
// for up to 25s which keeps the worker alive during active traffic.
chrome.alarms.create("instacartProxy", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "heartbeat") await runHeartbeat();
  else if (alarm.name === "reauthCheck") await runReauthCheck();
  else if (alarm.name === "instacartProxy") await runInstacartProxyOnce();
});

// Also kick it off at startup so we don't wait up to a minute after install.
runInstacartProxyOnce().catch(() => {});

/**
 * Poll the Hostcart server for Instacart requests that need to be executed
 * from real Chrome (CloudFront WAF blocks server-side fetches). Does up to
 * a couple of jobs per wake, then exits — the 1min alarm picks up the next
 * batch. Long-poll on the server side (25s) keeps the SW alive during
 * active usage.
 */
async function runInstacartProxyOnce() {
  const pairing = await getPairing();
  if (!pairing?.extensionToken) return;

  for (let i = 0; i < 3; i++) {
    let job;
    try {
      const res = await fetch(`${HOSTCART_API}/api/sessions/instacart-proxy-poll`, {
        headers: { "x-extension-token": pairing.extensionToken },
      });
      if (res.status === 204) return; // idle — nothing to do
      if (!res.ok) return;
      job = await res.json();
    } catch {
      return;
    }
    if (!job || !job.requestId) return;

    let result;
    try {
      const fetchRes = await fetch(job.url, {
        method: job.method || "GET",
        headers: job.headers || {},
        body: job.body || undefined,
        credentials: "include",
      });
      const body = await fetchRes.text();
      result = { status: fetchRes.status, body };
    } catch (err) {
      result = { status: 0, body: String(err?.message ?? err) };
    }

    try {
      await fetch(`${HOSTCART_API}/api/sessions/instacart-proxy-result`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-extension-token": pairing.extensionToken,
        },
        body: JSON.stringify({ requestId: job.requestId, ...result }),
      });
    } catch {
      // If result POST fails the server will time out the pending request
      // — caller retries on next cron cycle. No local state to clean up.
    }
  }
}

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
