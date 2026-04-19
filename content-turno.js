const HOST = "app.turnoverbnb.com";
const TOKEN_KEY_CANDIDATES = [
  "auth_token",
  "turno_auth",
  "access_token",
  "jwt",
  "id_token"
];

function findAuthToken() {
  for (const key of TOKEN_KEY_CANDIDATES) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      if (parsed?.token) return parsed.token;
      if (parsed?.access_token) return parsed.access_token;
    } catch {
      return raw;
    }
  }
  return null;
}

async function captureAndSend() {
  const token = findAuthToken();
  if (!token) return;
  try {
    await chrome.runtime.sendMessage({
      type: "authTokenFromPage",
      host: HOST,
      token
    });
  } catch {
    // runtime can disappear during navigation; ignore
  }
}

captureAndSend();

const origSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  origSetItem.call(this, key, value);
  if (this === window.localStorage && TOKEN_KEY_CANDIDATES.includes(key)) {
    captureAndSend();
  }
};

setInterval(captureAndSend, 60_000);
