// Loads content.js with a stubbed chrome API so the DOM logic can be exercised
// without installing the extension.
//
// Lookups are answered from the fixture below, offline, in the worker's shape.
// It is keyed like ofstats: a tagged player under "[TAG] name", and the bare
// name is a different record (as on ofstats, where bare "TeNa" is other
// people). So a badge that reads "Top 2%" on [LUX] TeNa proves the tagged name
// was asked; the names asked are listed in #out.
const FIXTURE = {
  // ofstats name (lowercased): [games, wins, expected wins]
  "[lux] tena": [516, 398, 60],
  tena: [1127, 200, 190], // the bare name: somebody else
  "[lux] jarques": [300, 90, 45],
  "[dfy] rage": [220, 50, 38],
  firedan: [150, 30, 29],
  weakguy: [80, 4, 12],
  midguy: [120, 20, 21],
};
const fake = ([games, wins, expectedWins]) => ({
  found: true,
  games,
  wins,
  winRate: (100 * wins) / games,
  ratedGames: games,
  ratedWins: wins,
  expectedWins,
  winsTop: null,
  modes: [{ mode: "Free For All", games, wins }],
  recentGames: [],
  firstSeen: null,
  lastSeen: null,
  conquests: 0,
  nukes: 0,
  gold: 0,
  bests: null,
  streak: 0,
  maps: [],
});
const asked = [];
window.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg.type === "getSettings") {
        const q = new URLSearchParams(location.search);
        // Any ?setting=value in the URL becomes a setting; 1/0 are booleans.
        const settings = {
          enabled: true,
          dataConsent: true, // the fixture is local; nothing leaves the page
          showGames: q.get("showGames") !== "0",
          explainMissing: q.get("explainMissing") !== "0",
        };
        for (const [k, v] of q) {
          settings[k] = v === "1" ? true : v === "0" ? false : v;
        }
        return settings;
      }
      if (msg.type === "lookup") {
        const out = {};
        for (const u of msg.usernames) {
          asked.push(u);
          const row = FIXTURE[u.toLowerCase()];
          out[u] = row ? fake(row) : { found: false, reason: "no-history" };
        }
        const pre = document.getElementById("out");
        if (pre) pre.textContent = `looked up: ${asked.join(" | ")}`;
        return out;
      }
      return null;
    },
  },
  storage: { onChanged: { addListener() {} } },
};
// Same load order as the manifest: shared modules first, content.js last.
(async () => {
  for (const file of ["themes.js", "scoring.js", "map-viewer.js", "charts.js", "dashboard.js", "timelapse.js", "recap.js", "chat.js", "content.js"]) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `../src/${file}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${file}`));
      document.head.appendChild(s);
    });
  }
})();
