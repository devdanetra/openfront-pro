// Small chart kit for the recap and the dashboard. Plain SVG / DOM, no library:
// a content script cannot pull one from a CDN (CSP) and bundling one for five
// chart shapes is not worth its weight.
//
// Nothing here carries a colour. Every mark gets a class (and, where it stands
// for a rank band, data-ofr-band), and content.css paints them from the theme
// tokens - so charts follow the theme like everything else, including light
// themes. Hover text is an SVG <title>, which needs no script.
(() => {
  if (globalThis.OFR_CHARTS) return;

  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const round = (v) => Math.round(v * 10) / 10;

  // "Nice" upper bound for an axis: 1, 2, 2.5, 5 x 10^n.
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const pow = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
    return 10 * pow;
  }

  function frame({ width, height, pad, label }) {
    const svg = svgEl("svg", {
      class: "ofr-chart",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": label,
    });
    return { svg, x0: pad.left, x1: width - pad.right, y0: pad.top, y1: height - pad.bottom };
  }

  // ---- line / step / area ------------------------------------------------------
  // series: [{ points: [{x, y}], cls, step, area, title }]
  // markers: [{ x, y?, label, kind }]  - a vertical rule (or a dot when y is given)
  // baseline: { y, label }            - a dashed horizontal reference
  function line({
    series,
    width = 340,
    height = 120,
    xMin,
    xMax,
    yMin = 0,
    yMax,
    xTicks = [],
    yTicks,
    xFormat = String,
    yFormat = String,
    markers = [],
    baseline = null,
    label = "chart",
  }) {
    const pad = { left: 30, right: 10, top: 12, bottom: 18 };
    const { svg, x0, x1, y0, y1 } = frame({ width, height, pad, label });
    // Only finite points are drawable; everything else would put NaN in the path.
    series = series.map((s) => ({ ...s, points: s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) }));
    const all = series.flatMap((s) => s.points);
    if (all.length === 0) return svg;
    const lox = xMin ?? Math.min(...all.map((p) => p.x));
    const hix = xMax ?? Math.max(...all.map((p) => p.x));
    const hiy = yMax ?? niceMax(Math.max(...all.map((p) => p.y), baseline?.y ?? 0));
    // Clamped: .ofr-chart is overflow:visible (for labels), so a value outside
    // the domain must not draw outside the plot.
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const sx = (x) => round(clamp(x0 + ((x1 - x0) * (num(x) - lox)) / (hix - lox || 1), x0, x1));
    const sy = (y) => round(clamp(y1 - ((y1 - y0) * (num(y) - yMin)) / (hiy - yMin || 1), y0, y1));

    for (const t of yTicks ?? [yMin, (yMin + hiy) / 2, hiy]) {
      svg.append(svgEl("line", { class: "ofr-chart-grid", x1: x0, x2: x1, y1: sy(t), y2: sy(t) }));
      svg.append(svgEl("text", { class: "ofr-chart-label", x: x0 - 4, y: sy(t) + 3, "text-anchor": "end" }, yFormat(t)));
    }
    for (const t of xTicks) {
      svg.append(svgEl("text", { class: "ofr-chart-label", x: sx(t), y: y1 + 12, "text-anchor": "middle" }, xFormat(t)));
    }
    if (baseline) {
      const rule = svgEl("line", { class: "ofr-chart-baseline", x1: x0, x2: x1, y1: sy(baseline.y), y2: sy(baseline.y) });
      if (baseline.title) rule.append(svgEl("title", {}, baseline.title));
      svg.append(rule);
      if (baseline.label) {
        svg.append(svgEl("text", { class: "ofr-chart-label", x: x1, y: sy(baseline.y) - 3, "text-anchor": "end" }, baseline.label));
      }
    }

    for (const s of series) {
      if (s.points.length === 0) continue;
      let d = "";
      s.points.forEach((p, i) => {
        if (i === 0) d += `M${sx(p.x)} ${sy(p.y)}`;
        else if (s.step) d += ` H${sx(p.x)} V${sy(p.y)}`;
        else d += ` L${sx(p.x)} ${sy(p.y)}`;
      });
      if (s.area) {
        const last = s.points[s.points.length - 1];
        svg.append(svgEl("path", { class: `ofr-chart-area ${s.cls ?? ""}`, d: `${d} L${sx(last.x)} ${sy(yMin)} L${sx(s.points[0].x)} ${sy(yMin)} Z` }));
      }
      const path = svgEl("path", { class: `ofr-chart-line ${s.cls ?? ""}`, d });
      if (s.title) path.append(svgEl("title", {}, s.title));
      svg.append(path);
      // "M x y" alone has no length: a one-point series would be invisible.
      if (s.points.length === 1) {
        svg.append(svgEl("circle", { class: `ofr-chart-dot ${s.cls ?? ""}`, cx: sx(s.points[0].x), cy: sy(s.points[0].y), r: 3 }));
      }
    }

    for (const m of markers) {
      if (!Number.isFinite(m.x) || m.x < lox || m.x > hix) continue; // not on this chart
      const g = svgEl("g", { class: "ofr-chart-marker", "data-kind": m.kind ?? "" });
      const x = sx(m.x);
      if (m.y === undefined) g.append(svgEl("line", { x1: x, x2: x, y1: y0, y2: y1 }));
      else g.append(svgEl("circle", { cx: x, cy: sy(m.y), r: 4.5 }));
      if (m.label) {
        const right = x > (x0 + x1) / 2;
        g.append(
          svgEl(
            "text",
            { x: right ? x - 5 : x + 5, y: m.y === undefined ? y0 + 8 + (m.row ?? 0) * 11 : sy(m.y) - 6, "text-anchor": right ? "end" : "start" },
            m.label,
          ),
        );
      }
      svg.append(g);
    }
    return svg;
  }

  // ---- columns: one bar per item (per game, per day...) --------------------------
  // items: [{ value, cls, band, title }]
  function columns({ items, width = 340, height = 90, yMax, yFormat = String, baseline = null, label = "chart" }) {
    const pad = { left: 30, right: 6, top: 8, bottom: 6 };
    const { svg, x0, x1, y0, y1 } = frame({ width, height, pad, label });
    if (items.length === 0) return svg;
    const hiy = yMax ?? niceMax(Math.max(...items.map((i) => num(i.value))));
    const sy = (y) => round(Math.min(y1, Math.max(y0, y1 - ((y1 - y0) * num(y)) / (hiy || 1))));
    for (const t of [0, hiy]) {
      svg.append(svgEl("line", { class: "ofr-chart-grid", x1: x0, x2: x1, y1: sy(t), y2: sy(t) }));
      svg.append(svgEl("text", { class: "ofr-chart-label", x: x0 - 4, y: sy(t) + 3, "text-anchor": "end" }, yFormat(t)));
    }
    const slot = (x1 - x0) / items.length;
    const w = Math.max(1, Math.min(14, slot * 0.72));
    items.forEach((item, i) => {
      const h = Math.max(1, y1 - sy(item.value));
      const rect = svgEl("rect", {
        class: `ofr-chart-col ${item.cls ?? ""}`,
        "data-ofr-band": item.band,
        x: round(x0 + slot * i + (slot - w) / 2),
        y: round(y1 - h),
        width: round(w),
        height: round(h),
        rx: 1,
      });
      if (item.title) rect.append(svgEl("title", {}, item.title));
      svg.append(rect);
    });
    if (baseline) {
      svg.append(svgEl("line", { class: "ofr-chart-baseline", x1: x0, x2: x1, y1: sy(baseline.y), y2: sy(baseline.y) }));
    }
    return svg;
  }

  // ---- compare: rows of grouped horizontal bars (you / winner / lobby) ------------
  // rows: [{ label, note, title, bars: [{ value, text, kind }] }]; each row scales to its own max
  // legend: [{ kind, label, title }] (title: the full wording, on hover)
  function compare({ rows, legend = [] }) {
    const wrap = el("div", "ofr-cmp");
    if (legend.length) {
      const lg = el("div", "ofr-chart-legend");
      for (const item of legend) {
        const key = el("span", "ofr-chart-key", item.label);
        key.dataset.kind = item.kind;
        if (item.title) key.title = item.title;
        lg.append(key);
      }
      wrap.append(lg);
    }
    for (const row of rows) {
      const top = Math.max(1, ...row.bars.map((b) => num(b.value)));
      const line = el("div", "ofr-cmp-row");
      if (row.title) line.title = row.title;
      const head = el("div", "ofr-cmp-head");
      head.append(el("span", "ofr-cmp-label", row.label));
      if (row.note) head.append(el("span", "ofr-cmp-note", row.note));
      line.append(head);
      for (const bar of row.bars) {
        const track = el("div", "ofr-cmp-track");
        const area = el("span", "ofr-cmp-area");
        const fill = el("span", "ofr-cmp-fill");
        fill.dataset.kind = bar.kind;
        fill.style.width = `${Math.max(1.5, (100 * Math.max(0, num(bar.value))) / top)}%`;
        area.append(fill);
        track.append(area, el("span", "ofr-cmp-value", bar.text ?? String(bar.value)));
        line.append(track);
      }
      wrap.append(line);
    }
    return wrap;
  }

  // ---- stacked: one bar split into labelled parts, with a legend ----------------------
  // parts: [{ label, value, text, slot }]  (slot 1..7 picks a token colour, content.css)
  // The bar keeps the given order; the legend lists the largest part first.
  // A share that would round to 0% reads "<1%", so a sliver never says nothing.
  const shareText = (share) => (share > 0 && share < 0.5 ? "<1%" : `${share.toFixed(0)}%`);
  function stacked({ parts }) {
    const live = parts.filter((p) => num(p.value) > 0);
    const total = live.reduce((a, p) => a + num(p.value), 0);
    const wrap = el("div", "ofr-stack");
    if (total <= 0) return wrap;
    const bar = el("div", "ofr-stack-bar");
    const legend = el("div", "ofr-chart-legend");
    const keys = [];
    for (const p of live) {
      const share = (100 * num(p.value)) / total;
      const seg = el("span", "ofr-stack-seg");
      seg.dataset.slot = String(p.slot);
      seg.style.width = `${share}%`;
      seg.title = `${p.label}: ${p.text ?? p.value} (${shareText(share)})`;
      bar.append(seg);
      const key = el("span", "ofr-chart-key", `${p.label} ${shareText(share)}`);
      key.dataset.slot = String(p.slot);
      keys.push([share, key]);
    }
    keys.sort((a, b) => b[0] - a[0]); // stable: equal shares keep their order
    legend.append(...keys.map(([, key]) => key));
    wrap.append(bar, legend);
    return wrap;
  }

  // ---- bands: how many players sit in each rank band ---------------------------------
  // counts: { elite, strong, good, average, low, unranked }, mine: band of the viewer
  function bands({ counts, mine = null, labels = {} }) {
    const order = ["elite", "strong", "good", "average", "low", "unranked"];
    const top = Math.max(1, ...order.map((b) => num(counts[b])));
    const wrap = el("div", "ofr-bands");
    for (const band of order) {
      const n = num(counts[band]);
      const col = el("div", "ofr-bands-col");
      if (band === mine) col.dataset.mine = "true";
      const stem = el("div", "ofr-bands-stem");
      const fill = el("span", "ofr-bands-fill");
      fill.dataset.ofrBand = band;
      fill.style.height = `${n === 0 ? 0 : Math.max(6, (100 * n) / top)}%`;
      stem.append(fill);
      col.append(el("span", "ofr-bands-count", String(n)), stem, el("span", "ofr-bands-label", labels[band] ?? band));
      col.title = `${labels[band] ?? band}: ${n} player${n === 1 ? "" : "s"}${band === mine ? " (you are here)" : ""}`;
      wrap.append(col);
    }
    return wrap;
  }

  // ---- ring / gauge: one value as an arc ------------------------------------------------
  // frac: 0..1 of the sweep. sweep 360 is a full ring starting at 12 o'clock; a
  // smaller sweep is a gauge open at the bottom. segments: [{ from, to, band }]
  // paint the track in faint rank-band colours. marker: { frac, title } is a tick
  // across the ring. pre / value / sub: text in the middle, top to bottom.
  // The arc's colour comes from data-ofr-band (rank bands) or data-kind on the
  // <svg> (dashboard.css), never from here.
  const clamp01 = (v) => Math.max(0, Math.min(1, num(v)));
  const r2 = (v) => Math.round(v * 100) / 100;
  function ring({
    frac,
    size = 96,
    thickness = 10,
    sweep = 360,
    band = null,
    kind = null,
    segments = null,
    marker = null,
    pre = null,
    value = null,
    sub = null,
    label = "chart",
    title = null,
  }) {
    const svg = svgEl("svg", {
      class: "ofr-ring",
      viewBox: "0 0 100 100",
      width: size,
      height: size,
      role: "img",
      "aria-label": label,
      "data-ofr-band": band,
      "data-kind": kind,
    });
    if (title) svg.append(svgEl("title", {}, title));
    const r = 50 - thickness / 2 - 4;
    const whole = Math.min(360, Math.max(10, sweep)) / 3.6; // of pathLength 100
    const start = sweep >= 360 ? -90 : 90 + (360 - sweep) / 2; // the gap centred at the bottom
    const arc = (from, to, cls, attrs = {}) => {
      const len = r2(Math.max(0, to - from) * whole);
      return svgEl("circle", {
        class: cls,
        cx: 50,
        cy: 50,
        r: r2(r),
        pathLength: 100,
        "stroke-width": thickness,
        "stroke-dasharray": `${len} ${r2(100 - len + 1)}`,
        "stroke-dashoffset": r2(-from * whole),
        transform: `rotate(${start} 50 50)`,
        ...attrs,
      });
    };
    if (segments?.length) {
      const gap = 0.006;
      for (const s of segments) {
        svg.append(arc(clamp01(s.from) + gap, clamp01(s.to) - gap, "ofr-ring-seg", { "data-ofr-band": s.band }));
      }
    } else {
      svg.append(arc(0, 1, "ofr-ring-track"));
    }
    const f = clamp01(frac);
    if (f > 0) svg.append(arc(0, f, "ofr-ring-arc"));
    if (marker && Number.isFinite(marker.frac)) {
      const deg = ((start + clamp01(marker.frac) * (whole * 3.6)) * Math.PI) / 180;
      const at = (rad) => [r2(50 + rad * Math.cos(deg)), r2(50 + rad * Math.sin(deg))];
      const [xa, ya] = at(r - thickness / 2 - 3);
      const [xb, yb] = at(r + thickness / 2 + 3);
      // a wider line in the background colour under the tick, so the tick still
      // shows where the arc is the same colour as the tick (high contrast: white on white)
      svg.append(svgEl("line", { class: "ofr-ring-mark-halo", x1: xa, y1: ya, x2: xb, y2: yb }));
      const tick = svgEl("line", { class: "ofr-ring-mark", x1: xa, y1: ya, x2: xb, y2: yb });
      if (marker.title) tick.append(svgEl("title", {}, marker.title));
      svg.append(tick);
    }
    const lines = [pre, value, sub].filter((t) => t != null && t !== "");
    if (lines.length) {
      // the value is the big line; pre sits above it, sub below
      const vy = sweep >= 360 ? 50 : 52;
      if (pre != null) svg.append(svgEl("text", { class: "ofr-ring-pre", x: 50, y: vy - 17, "text-anchor": "middle", "dominant-baseline": "central" }, pre));
      if (value != null) svg.append(svgEl("text", { class: "ofr-ring-value", x: 50, y: vy, "text-anchor": "middle", "dominant-baseline": "central" }, value));
      if (sub != null) svg.append(svgEl("text", { class: "ofr-ring-sub", x: 50, y: vy + 17, "text-anchor": "middle", "dominant-baseline": "central" }, sub));
    }
    return svg;
  }

  // ---- icons: small line glyphs in currentColor (24 x 24) --------------------------------
  const pt = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    return `${r2(12 + r * Math.cos(a))} ${r2(12 + r * Math.sin(a))}`;
  };
  const wedge = (r1, rr, a0, a1) =>
    `M${pt(r1, a0)} L${pt(rr, a0)} A${rr} ${rr} 0 0 1 ${pt(rr, a1)} L${pt(r1, a1)} A${r1} ${r1} 0 0 0 ${pt(r1, a0)} Z`;
  const ICONS = {
    clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7v5l3.5 2" }]],
    shield: [["path", { d: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" }]],
    coins: [
      ["ellipse", { cx: 12, cy: 6, rx: 7, ry: 3 }],
      ["path", { d: "M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" }],
      ["path", { d: "M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" }],
    ],
    trophy: [
      ["path", { d: "M7 4h10v5a5 5 0 0 1-10 0z" }],
      ["path", { d: "M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3" }],
      ["path", { d: "M12 14v4M8 20.5h8" }],
    ],
    flag: [["path", { d: "M5 21V4" }], ["path", { d: "M5 4h12l-2.5 4 2.5 4H5" }]],
    swords: [
      ["path", { d: "M5 5l11 11M13 18.5l5.5-5.5M16 16l3 3" }],
      ["path", { d: "M19 5L8 16M5.5 13l5.5 5.5M8 16l-3 3" }],
    ],
    nuke: [
      ["circle", { class: "fill", cx: 12, cy: 12, r: 1.8 }],
      ["path", { class: "fill", d: [-90, 30, 150].map((c) => wedge(3.4, 9.5, c - 30, c + 30)).join(" ") }],
      ["circle", { cx: 12, cy: 12, r: 10.5, class: "thin" }],
    ],
    flame: [["path", { class: "fill", d: "M12 2.5c.7 3.3 5 5.3 5 10.5a5 5 0 0 1-10 0c0-2.7 1.4-4.4 2.5-5.4.2 1.7.9 2.7 2 3.2-.3-3.2-.1-5.8.5-8.3z" }]],
    users: [
      ["circle", { cx: 9, cy: 8, r: 3.5 }],
      ["path", { d: "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" }],
      ["path", { d: "M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6c1.9.8 3 2.8 3 5.4" }],
    ],
    gear: [
      ["circle", { cx: 12, cy: 12, r: 3 }],
      [
        "path",
        {
          d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
        },
      ],
    ],
    search: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "M20 20l-3.5-3.5" }]],
    skull: [
      ["path", { d: "M12 3a7 7 0 0 0-7 7c0 2.4 1.2 4.1 3 5.2V18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.8c1.8-1.1 3-2.8 3-5.2a7 7 0 0 0-7-7z" }],
      ["circle", { class: "fill", cx: 9.3, cy: 10.5, r: 1.6 }],
      ["circle", { class: "fill", cx: 14.7, cy: 10.5, r: 1.6 }],
      ["path", { d: "M10.5 19v2M13.5 19v2" }],
    ],
    trend: [["path", { d: "M3 17l6-6 4 4 8-8" }], ["path", { d: "M15 7h6v6" }]],
    rise: [["path", { d: "M6 12l6-6 6 6M6 19l6-6 6 6" }]],
    star: [["path", { d: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" }]],
    bolt: [["path", { d: "M13 2L4 14h7l-1 8 9-12h-7z" }]],
    city: [["path", { d: "M3 21h18M5 21V10l5-3v14M10 21V4h9v17" }], ["path", { d: "M13 8h3M13 12h3M13 16h3" }]],
    ship: [["path", { d: "M3 15l2.5 5h13l2.5-5z" }], ["path", { d: "M12 3v12" }], ["path", { d: "M12 4.5l6 7.5h-6" }]],
    hammer: [["path", { d: "M14.5 3.5l6 6-3 3-6-6z" }], ["path", { d: "M12.5 8.5l-8.3 8.3a2.1 2.1 0 0 0 3 3l8.3-8.3" }]],
    calendar: [
      ["path", { d: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" }],
      ["path", { d: "M3 10h18M8 3v4M16 3v4" }],
    ],
    info: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 11v5.5" }], ["circle", { class: "fill", cx: 12, cy: 7.6, r: 1.3 }]],
    target: [["circle", { cx: 12, cy: 12, r: 9 }], ["circle", { cx: 12, cy: 12, r: 5 }], ["circle", { class: "fill", cx: 12, cy: 12, r: 1.6 }]],
    train: [
      ["path", { d: "M8 3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" }],
      ["path", { d: "M5 10h14M8.5 21l2-4M15.5 21l-2-4" }],
    ],
  };
  function icon(name, cls = "") {
    const svg = svgEl("svg", { class: `ofr-icon ${cls}`.trim(), viewBox: "0 0 24 24", "aria-hidden": "true", "data-icon": name });
    for (const [tag, attrs] of ICONS[name] ?? []) svg.append(svgEl(tag, attrs));
    return svg;
  }

  // ---- pips: a row of small marks, the first `lit` of them on --------------------------
  // glyph: "dot" or an icon name (e.g. "flame").
  function pips({ lit, total, glyph = "dot", label = "", title = null }) {
    const wrap = el("span", "ofr-pips");
    wrap.dataset.glyph = glyph;
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", label);
    if (title) wrap.title = title;
    const n = Math.max(0, Math.round(num(total)));
    for (let i = 0; i < n; i++) {
      const p = glyph === "dot" ? el("span", "ofr-pip") : icon(glyph, "ofr-pip");
      if (i < num(lit)) p.classList.add("on");
      wrap.append(p);
    }
    return wrap;
  }

  // ---- meter: one thin horizontal bar, frac 0..1 of its track ----------------------------
  // kind / band pick the colour (dashboard.css); mark: { frac, title } is a tick.
  function meter({ frac, kind = null, band = null, mark = null, title = null, label = null }) {
    const track = el("span", "ofr-meter");
    const fill = el("span", "ofr-meter-fill");
    fill.style.width = `${(100 * clamp01(frac)).toFixed(1)}%`;
    if (kind) fill.dataset.kind = kind;
    if (band) fill.dataset.ofrBand = band;
    track.append(fill);
    if (mark && Number.isFinite(mark.frac)) {
      const tick = el("span", "ofr-meter-mark");
      tick.style.left = `${(100 * clamp01(mark.frac)).toFixed(1)}%`;
      if (mark.title) tick.title = mark.title;
      track.append(tick);
    }
    if (title) track.title = title;
    if (label) {
      track.setAttribute("role", "img");
      track.setAttribute("aria-label", label);
    }
    return track;
  }

  // ---- mirror: two sides of one measure, bars growing out from the middle ----------------
  // rows: [{ label, title, a: { frac, text, better }, b: { frac, text, better } }]
  function mirror({ rows }) {
    const wrap = el("div", "ofr-mirror");
    const side = (v, which) => {
      const cell = el("div", `ofr-mirror-side ${which}`);
      const track = el("span", "ofr-mirror-track");
      const fill = el("span", "ofr-mirror-fill");
      const f = v && Number.isFinite(v.frac) ? clamp01(v.frac) : 0;
      fill.style.width = `${f > 0 ? Math.max(2, 100 * f).toFixed(1) : 0}%`;
      if (v?.better) cell.dataset.better = "true";
      track.append(fill);
      cell.append(el("span", "ofr-mirror-value", v?.text ?? "—"), track);
      return cell;
    };
    for (const row of rows) {
      const line = el("div", "ofr-mirror-row");
      if (row.title) line.title = row.title;
      line.append(side(row.a, "a"), el("span", "ofr-mirror-label", row.label), side(row.b, "b"));
      wrap.append(line);
    }
    return wrap;
  }

  globalThis.OFR_CHARTS = { line, columns, compare, stacked, bands, niceMax, ring, icon, pips, meter, mirror };
})();
