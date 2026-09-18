// First-run disclosure. Nothing is looked up anywhere until "I agree" is pressed
// here (the popup's "Read and turn on" opens this page): the worker refuses lookup
// messages while dataConsent is not true.
const state = document.getElementById("state");

// The state card (.ofr-state): a title line, one plain line, and - once lookups
// are on - a link to the game. Static strings only, built with DOM methods.
function show(on) {
  state.dataset.on = String(on);
  state.dataset.kind = on ? "ok" : "empty";
  const text = document.createElement("span");
  const title = document.createElement("span");
  title.className = "ofr-state-title";
  title.textContent = on ? "Rank lookups are ON." : "Rank lookups are OFF.";
  text.append(title, on ? "Open or reload openfront.io to see them." : "No names or game ids are sent.");
  if (on) {
    const actions = document.createElement("span");
    actions.className = "ofr-state-actions";
    const open = document.createElement("a");
    open.className = "ofr-btn ofr-btn-sm";
    open.href = "https://openfront.io/";
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open openfront.io";
    actions.append(open);
    text.append(actions);
  }
  state.replaceChildren(text);
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
