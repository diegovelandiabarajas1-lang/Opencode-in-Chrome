const $ = (id) => document.getElementById(id);
chrome.storage.local.get(["host", "token"]).then((v) => {
  if (v.host) $("host").value = v.host;
  if (v.token) $("token").value = v.token;
});
$("save").onclick = async () => {
  await chrome.storage.local.set({ host: $("host").value.trim(), token: $("token").value.trim() });
  chrome.runtime.sendMessage({ type: "reconnect" });
  $("st").textContent = "Guardado";
};
