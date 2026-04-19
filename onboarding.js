const HOSTCART_API = "https://hostcart.nlma.io";

document.getElementById("pairBtn").addEventListener("click", async () => {
  const result = document.getElementById("result");
  const code = document.getElementById("pairInput").value.trim();
  if (!/^\d{6}$/.test(code)) {
    result.textContent = "Enter the 6-digit code from hostcart.nlma.io";
    result.className = "result err";
    return;
  }
  result.textContent = "Connecting...";
  result.className = "result";
  try {
    const res = await fetch(`${HOSTCART_API}/api/extensions/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!res.ok) {
      result.textContent = `Pairing failed: ${res.status}`;
      result.className = "result err";
      return;
    }
    const data = await res.json();
    await chrome.runtime.sendMessage({
      type: "pair",
      pairing: {
        extensionToken: data.extension_token,
        email: data.email,
        userId: data.user_id
      }
    });
    result.textContent = `Connected as ${data.email}. You can close this tab.`;
    result.className = "result ok";
  } catch (err) {
    result.textContent = `Error: ${err.message}`;
    result.className = "result err";
  }
});
