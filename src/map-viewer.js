// Full-screen, zoomable map view, opened from the lobby preview.
//
// The only map *image* OpenFront ships is a 500x250 thumbnail, which turns to
// mush when enlarged. So this renders the real terrain instead: `map.bin` is one
// byte per tile (bit 7 land, bit 6 shoreline, bit 5 ocean, low 5 bits
// elevation) and the map's manifest gives its dimensions — 2000x1000 for World.
// Colours follow the game's own encodeTerrainTile so the view matches what you
// will play on.
(() => {
  if (globalThis.__ofrViewerLoaded) return;
  globalThis.__ofrViewerLoaded = true;

  const OCEAN = [71, 133, 181]; // #4785b5, the game's terrain.oceanColor
  const BACKGROUND = [60, 60, 60]; // #3c3c3c, impassable peaks
  const SAND = [204, 203, 158];
  const PLAINS = [190, 220, 138];
  const HIGHLAND = [200, 183, 138];
  const MOUNTAIN = [230, 230, 230];

  const MIN_SCALE = 0.05;
  const MAX_SCALE = 40;

  // Mirrors encodeTerrainTile in the game's ColorUtils.
  function paint(bytes, width, height) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const tb = bytes[i];
      const isLand = (tb & 0x80) !== 0;
      const isShore = (tb & 0x40) !== 0;
      const magnitude = tb & 0x1f;
      let r;
      let g;
      let b;

      if (isLand && magnitude === 31) {
        [r, g, b] = BACKGROUND;
      } else if (isLand && isShore) {
        [r, g, b] = SAND;
      } else if (isLand) {
        if (magnitude < 10) {
          r = PLAINS[0];
          g = PLAINS[1] - 2 * magnitude;
          b = PLAINS[2];
        } else if (magnitude < 20) {
          const m = magnitude - 10;
          r = Math.min(255, HIGHLAND[0] + 2 * m);
          g = Math.min(255, HIGHLAND[1] + 2 * m);
          b = Math.min(255, HIGHLAND[2] + 2 * m);
        } else {
          const m = Math.floor(magnitude / 2);
          r = Math.min(255, MOUNTAIN[0] + m);
          g = Math.min(255, MOUNTAIN[1] + m);
          b = Math.min(255, MOUNTAIN[2] + m);
        }
      } else if (isShore) {
        r = Math.round(0.7 * OCEAN[0] + 76.5);
        g = Math.round(0.7 * OCEAN[1] + 76.5);
        b = Math.round(0.7 * OCEAN[2] + 76.5);
      } else {
        const m = Math.min(magnitude, 10);
        r = Math.max(0, OCEAN[0] - m);
        g = Math.max(0, OCEAN[1] - m);
        b = Math.max(0, OCEAN[2] - m);
      }

      const o = i * 4;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
      pixels[o + 3] = 255;
    }
    return new ImageData(pixels, width, height);
  }

  async function loadTerrain(info) {
    const manifest = await fetch(info.terrainManifest).then((r) => {
      if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
      return r.json();
    });
    const dims = manifest.map;
    if (!dims?.width || !dims?.height) throw new Error("manifest has no size");

    const bytes = new Uint8Array(
      await fetch(info.terrain).then((r) => {
        if (!r.ok) throw new Error(`terrain HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    );
    if (bytes.length !== dims.width * dims.height) {
      throw new Error(
        `terrain is ${bytes.length} bytes, expected ${dims.width * dims.height}`,
      );
    }

    const source = document.createElement("canvas");
    source.width = dims.width;
    source.height = dims.height;
    source.getContext("2d").putImageData(paint(bytes, dims.width, dims.height), 0, 0);
    return { source, width: dims.width, height: dims.height };
  }

  function open(info) {
    // A viewer already open is closed properly, so its listeners, observer and
    // scroll lock go with it (a bare remove() left them behind).
    const existing = document.querySelector(".ofr-viewer");
    if (typeof existing?.__ofrClose === "function") existing.__ofrClose();
    else existing?.remove();

    const root = document.createElement("div");
    root.className = "ofr-viewer";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    // static markup only; the map name goes in with textContent below
    root.innerHTML = `
      <div class="ofr-viewer-bar">
        <span class="ofr-viewer-title"></span>
        <span class="ofr-viewer-hint">scroll to zoom · drag to pan · Esc to close</span>
        <button type="button" class="ofr-btn ofr-viewer-btn" data-act="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <button type="button" class="ofr-btn ofr-viewer-btn" data-act="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" class="ofr-btn ofr-viewer-btn" data-act="fit" aria-label="Fit to screen" title="Fit to screen (0)">Fit</button>
        <button type="button" class="ofr-btn ofr-btn-icon ofr-viewer-btn" data-act="close" aria-label="Close map" title="Close (Esc)">✕</button>
      </div>
      <div class="ofr-viewer-stage"><canvas></canvas></div>
      <div class="ofr-viewer-status">Loading full-resolution terrain…</div>`;
    document.body.appendChild(root);
    const returnFocus = document.activeElement;
    // the page underneath stops scrolling while this is open (content.css)
    document.documentElement.dataset.ofrModal = "viewer";

    root.querySelector(".ofr-viewer-title").textContent = info.map;
    root.setAttribute("aria-label", `${info.map} map`);
    const stage = root.querySelector(".ofr-viewer-stage");
    const canvas = root.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const status = root.querySelector(".ofr-viewer-status");

    let terrain = null;
    let full = false; // the real terrain, not the lobby thumbnail
    let scale = 1;
    let originX = 0;
    let originY = 0;

    function resize() {
      const rect = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function fit() {
      if (!terrain) return;
      const rect = stage.getBoundingClientRect();
      const pad = 24; // a margin all round, so the map never touches the bars
      scale = Math.max(
        MIN_SCALE,
        Math.min((rect.width - 2 * pad) / terrain.width, (rect.height - 2 * pad) / terrain.height),
      );
      originX = (rect.width - terrain.width * scale) / 2;
      originY = (rect.height - terrain.height * scale) / 2;
      draw();
    }

    function draw() {
      const rect = stage.getBoundingClientRect();
      ctx.save();
      ctx.setTransform(
        window.devicePixelRatio || 1,
        0,
        0,
        window.devicePixelRatio || 1,
        0,
        0,
      );
      // transparent: the stage behind the canvas carries the theme's colour
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (terrain && full) status.textContent = `${terrain.width} × ${terrain.height} tiles · ${Math.round(scale * 100)}%`;
      if (terrain) {
        // Nearest-neighbour, like the game's own terrain texture: zooming in
        // should show crisp tiles rather than a smeared blur.
        ctx.imageSmoothingEnabled = scale < 1;
        ctx.drawImage(
          terrain.source,
          originX,
          originY,
          terrain.width * scale,
          terrain.height * scale,
        );
      }
      ctx.restore();
    }

    function zoomAt(factor, clientX, clientY) {
      if (!terrain) return;
      const rect = stage.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      // Keep the point under the cursor fixed.
      originX = px - ((px - originX) * next) / scale;
      originY = py - ((py - originY) * next) / scale;
      scale = next;
      draw();
    }

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey, true);
      ro.disconnect();
      root.remove();
      if (document.documentElement.dataset.ofrModal === "viewer") delete document.documentElement.dataset.ofrModal;
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus({ preventScroll: true });
    }

    function onResize() {
      resize();
      draw();
    }

    function zoomCentre(factor) {
      const rect = stage.getBoundingClientRect();
      zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    // Keys while the viewer is open: Esc closes, + / = zoom in, - zooms out, 0 fits.
    // Captured and stopped, so the game behind never sees them.
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // aria-modal: Tab cycles through the viewer's own buttons, never the page behind
      if (e.key === "Tab") {
        const stops = [...root.querySelectorAll("button")];
        if (!stops.length) return;
        const at = stops.indexOf(document.activeElement);
        const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        e.preventDefault();
        e.stopPropagation();
        stops[next].focus({ preventScroll: true });
        return;
      }
      const act = { Escape: "close", "+": "in", "=": "in", "-": "out", _: "out", 0: "fit" }[e.key];
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      if (act === "close") close();
      else if (act === "fit") fit();
      else zoomCentre(act === "in" ? 1.4 : 1 / 1.4);
    }

    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
      },
      { passive: false },
    );

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    stage.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      originX += e.clientX - lastX;
      originY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      draw();
    });
    const endDrag = () => {
      dragging = false;
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);

    root.addEventListener("click", (e) => {
      const act = e.target?.closest?.("[data-act]")?.dataset?.act;
      if (act === "close" || e.target === root) close();
      if (act === "fit") fit();
      if (act === "in") zoomCentre(1.4);
      if (act === "out") zoomCentre(1 / 1.4);
    });

    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    // The stage can change size without the window doing so (the page relayouts
    // underneath); keep the canvas backing store in step.
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(stage);
    root.__ofrClose = close;
    resize();
    draw();
    root.querySelector('[data-act="close"]').focus({ preventScroll: true });

    // The lobby thumbnail at once, so the view is never empty; the real terrain
    // replaces it when it arrives.
    const showThumbnail = (then) => {
      if (!info.thumbnail) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (full) return; // the terrain won the race
        terrain = { source: img, width: img.naturalWidth, height: img.naturalHeight };
        requestAnimationFrame(() => {
          resize();
          fit();
        });
        then?.();
      };
      img.src = info.thumbnail;
    };
    showThumbnail();

    loadTerrain(info)
      .then((loaded) => {
        terrain = loaded;
        full = true;
        // Fit on the next frame: measuring the stage in the same tick as the
        // load can read a rect the browser has not laid out yet, which opens
        // the map part-zoomed instead of fitted.
        requestAnimationFrame(() => {
          resize();
          fit();
        });
      })
      .catch((err) => {
        status.textContent = "Full-resolution terrain is unavailable, so this is the lobby preview.";
        status.title = err?.message ?? String(err);
        if (!terrain) showThumbnail();
      });
  }

  globalThis.__ofrOpenMapViewer = open;
})();
