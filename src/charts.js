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
      svg.append(svgEl("line", { class: "ofr-chart-baseline", x1: x0, x2: x1, y1: sy(baseline.y), y2: sy(baseline.y) }));
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
      else g.append(svgEl("circle", { cx: x, cy: sy(m.y), r: 3.5 }));
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
  // rows: [{ label, note, bars: [{ value, text, kind }] }]; each row scales to its own max
  function compare({ rows, legend = [] }) {
    const wrap = el("div", "ofr-cmp");
    if (legend.length) {
      const lg = el("div", "ofr-chart-legend");
      for (const item of legend) {
        const key = el("span", "ofr-chart-key", item.label);
        key.dataset.kind = item.kind;
        lg.append(key);
      }
      wrap.append(lg);
    }
    for (const row of rows) {
      const top = Math.max(1, ...row.bars.map((b) => num(b.value)));
      const line = el("div", "ofr-cmp-row");
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
  // parts: [{ label, value, text, slot }]  (slot 1..6 picks a token colour)
  function stacked({ parts }) {
    const live = parts.filter((p) => num(p.value) > 0);
    const total = live.reduce((a, p) => a + num(p.value), 0);
    const wrap = el("div", "ofr-stack");
    if (total <= 0) return wrap;
    const bar = el("div", "ofr-stack-bar");
    const legend = el("div", "ofr-chart-legend");
    for (const p of live) {
      const share = (100 * num(p.value)) / total;
      const seg = el("span", "ofr-stack-seg");
      seg.dataset.slot = String(p.slot);
      seg.style.width = `${share}%`;
      seg.title = `${p.label}: ${p.text ?? p.value} (${share.toFixed(0)}%)`;
      bar.append(seg);
      const key = el("span", "ofr-chart-key", `${p.label} ${share.toFixed(0)}%`);
      key.dataset.slot = String(p.slot);
      legend.append(key);
    }
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

  globalThis.OFR_CHARTS = { line, columns, compare, stacked, bands, niceMax };
})();
