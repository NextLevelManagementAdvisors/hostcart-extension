const HOSTCART_API = "https://hostcart.nlma.io";
const SERVICES = ["instacart", "turno"];

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

async function getPairing() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getPairing" }, (r) => resolve(r?.pairing ?? null));
  });
}

async function render() {
  const body = document.getElementById("body");
  body.innerHTML = "";
  const pairing = await getPairing();

  if (!pairing?.extensionToken) {
    body.appendChild(el(`
      <div class="status unpaired">Not connected to Hostcart</div>
    `));
    body.appendChild(el(`
      <input class="pair-input" id="pairInput" placeholder="000000" maxlength="6" inputmode="numeric">
    `));
    const btn = el(`<button class="primary">Connect with pairing code</button>`);
    btn.onclick = onPair;
    body.appendChild(btn);
    body.appendChild(el(`
      <div class="hint">Get a 6-digit code at hostcart.nlma.io/settings/extension</div>
    `));
    return;
  }

  body.appendChild(el(`
    <div class="status paired">Connected as ${escape(pairing.email ?? "unknown")}</div>
  `));

  const sessions = await fetchSessions(pairing.extensionToken);
  for (const name of SERVICES) {
    const s = sessions.find((x) => x.service === name);
    const label = s?.last_used_at ? formatAge(s.last_used_at) : "never captured";
    const klass = !s ? "" : daysSince(s.last_used_at) > 25 ? "stale" : "ok";
    body.appendChild(el(`
      <div class="service">
        <span class="service-name">${capitalize(name)}</span>
        <span class="service-status ${klass}">${label}</span>
      </div>
    `));
  }

  const refresh = el(`<button>Refresh now</button>`);
  refresh.onclick = onRefresh;
  body.appendChild(refresh);

  const disconnect = el(`<button>Disconnect</button>`);
  disconnect.onclick = onDisconnect;
  body.appendChild(disconnect);
}

async function onPair() {
  const code = document.getElementById("pairInput").value.trim();
  if (!/^\d{6}$/.test(code)) return alert("Enter the 6-digit code");
  try {
    const res = await fetch(`${HOSTCART_API}/api/extensions/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!res.ok) return alert(`Pairing failed: ${res.status}`);
    const data = await res.json();
    await chrome.runtime.sendMessage({
      type: "pair",
      pairing: {
        extensionToken: data.extension_token,
        email: data.email,
        userId: data.user_id
      }
    });
    render();
  } catch (err) {
    alert(`Pairing error: ${err.message}`);
  }
}

async function onRefresh() {
  for (const name of SERVICES) {
    const host = name === "instacart" ? "instacart.com" : "app.turnoverbnb.com";
    await chrome.runtime.sendMessage({ type: "manualCapture", host });
  }
  render();
}

async function onDisconnect() {
  await chrome.storage.local.remove("pairing");
  render();
}

async function fetchSessions(token) {
  try {
    const res = await fetch(`${HOSTCART_API}/api/sessions`, {
      headers: { "x-extension-token": token }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.sessions ?? [];
  } catch {
    return [];
  }
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function formatAge(iso) {
  const d = daysSince(iso);
  if (d < 1) return "fresh";
  if (d < 2) return "1 day ago";
  return `${Math.floor(d)} days ago`;
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

render();
