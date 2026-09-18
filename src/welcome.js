// First-run disclosure. Nothing is looked up anywhere until "I agree" is pressed
// here (or the same switch is used in the popup): the worker refuses lookup
// messages while dataConsent is not true.
const state = document.getElementById("state");

function show(on) {
  state.dataset.on = String(on);
  state.textContent = on
    ? "Rank lookups are ON. Open or reload openfront.io to see them."
    : "Rank lookups are OFF. Nothing is sent anywhere.";
}

async function set(on) {
  await chrome.storage.sync.set({ dataConsent: on });
  show(on);
}

document.getElementById("agree").addEventListener("click", () => set(true));
document.getElementById("decline").addEventListener("click", () => set(false));

chrome.storage.sync.get({ dataConsent: false, theme: "classic" }).then((s) => {
  show(s.dataConsent === true);
  if (s.theme && s.theme !== "classic" && globalThis.OFR_THEMES?.[s.theme]) {
    document.documentElement.dataset.ofrTheme = s.theme;
  }
});
