// Loads content.js with a stubbed chrome API so the DOM logic can be exercised
// without installing the extension.
window.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      if (msg.type === "getSettings") {
        const q = new URLSearchParams(location.search);
        // Any ?setting=value in the URL becomes a setting; 1/0 are booleans.
        const settings = {
          enabled: true,
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
          const r = await fetch(
            `https://trackerfront.com/api/public/search?q=${encodeURIComponent(u)}&limit=10`,
          ).then((r) => r.json());
          const m = r.find((x) => (x.display_name || "").toLowerCase() === u.toLowerCase());
          if (!m) { out[u] = { found: false }; continue; }
          const d = await fetch(
            `https://trackerfront.com/api/public/players/${m.public_uuid}`,
          ).then((r) => r.json());
          out[u] = {
            found: true, username: m.display_name, verified: m.verified === true,
            tier: d.rank?.name ?? null, rr: d.rank?.rr ?? null,
            position: d.global_position ?? null, totalRanked: d.total_ranked ?? null,
          };
        }
        return out;
      }
      return null;
    },
  },
  storage: { onChanged: { addListener() {} } },
};
// Same load order as the manifest: shared modules first, content.js last.
(async () => {
  for (const file of ["themes.js", "scoring.js", "map-viewer.js", "charts.js", "dashboard.js", "recap.js", "chat.js", "content.js"]) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `../src/${file}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${file}`));
      document.head.appendChild(s);
    });
  }
})();
