// Theme catalogue: the ONE list of themes. A theme restyles everything the
// extension draws (badges, cards, dashboard, recap, share image, this popup)
// and, unless "Recolour OpenFront too" is switched off, OpenFront's own pages.
//
// A theme is three things, all keyed by the same id:
//   - here: the name in the picker, a one-line description, the icon set, and
//     `site`, the recipe for OpenFront's palette (hues per role, how tinted the
//     surfaces are, chroma boost, light or dark);
//   - src/content.css: a token block, html[data-ofr-theme="<id>"] { --ofr-*: … };
//   - src/page-themes.css: GENERATED from `site` by tools/gen-page-themes.mjs,
//     which also checks that the three agree. Run it after editing this file.
//
// "classic" has no `site`: it is the look OpenFront ships with.
//
// The high-contrast set uses words, because pictograms are the first thing to
// go for someone who cannot rely on colour or fine detail.
globalThis.OFR_THEMES = {
  classic: {
    label: "Classic",
    blurb: "OpenFront's own colours",
    icons: { map: "\u{1F5FA}", hot: "\u{1F525}", cold: "❄", smurf: "⚠", star: "★", trophy: "\u{1F3C6}" },
    site: null,
  },
  neon: {
    label: "Neon",
    blurb: "black glass, glowing cyan and magenta",
    icons: { map: "◈", hot: "⚡", cold: "❄︎", smurf: "‼", star: "✦", trophy: "♛" },
    site: { primary: 200, success: 142, danger: 330, warning: 100, accent: 300, surfaceHue: 285, surfaceC: 0.06, boost: 1.25, light: false },
  },
  tactical: {
    label: "Tactical",
    blurb: "olive command console, monospace",
    icons: { map: "MAP ", hot: "▲", cold: "▼", smurf: "!", star: "◆", trophy: "★" },
    site: { primary: 125, success: 130, danger: 40, warning: 80, accent: 165, surfaceHue: 125, surfaceC: 0.025, boost: 0.7, light: false },
  },
  pastel: {
    label: "Pastel",
    blurb: "light, soft lilac",
    icons: { map: "\u{1F5FA}", hot: "✨", cold: "\u{1F4A7}", smurf: "\u{1F440}", star: "\u{1F49B}", trophy: "\u{1F380}" },
    site: { primary: 290, success: 155, danger: 0, warning: 75, accent: 330, surfaceHue: 300, surfaceC: 0.02, boost: 0.6, light: true },
  },
  mono: {
    label: "Mono",
    blurb: "greyscale",
    icons: { map: "m", hot: "+", cold: "−", smurf: "!", star: "*", trophy: "#1" },
    site: { primary: 0, success: 0, danger: 0, warning: 0, accent: 0, surfaceHue: 0, surfaceC: 0, boost: 0, light: false },
  },
  contrast: {
    label: "High contrast",
    blurb: "pure black, words instead of icons",
    icons: { map: "MAP ", hot: "HOT", cold: "COLD", smurf: "SMURF?", star: "★", trophy: "WIN" },
    site: { primary: 240, success: 145, danger: 50, warning: 95, accent: 240, surfaceHue: 0, surfaceC: 0, boost: 1.35, light: false, contrast: true },
  },
};
