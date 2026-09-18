// Timelapse of the game you just played: the whole map, who owned what, from
// the first minute to the last - independent of where your camera was.
//
// page-probe.js (page world) takes a small ownership picture every few seconds
// by READING the client's tile buffer, and posts it here as a WebP blob. This
// file keeps the frames (memory only, this tab only, thrown away with the next
// game), plays them in the recap, and exports them:
//   - WebM video  (MediaRecorder on a canvas; small, Discord plays it inline)
//   - GIF         (own encoder below; big, but works everywhere)
// Nothing is uploaded anywhere. Frames arrive over window.postMessage, which the
// page could fake, so every field is checked; the worst a fake can do is put
// wrong pictures in your own timelapse.
(() => {
  if (globalThis.OFR_LAPSE) return;

  const MAX_FRAMES = 360; // beyond this every other frame is dropped and the interval doubles
  const FPS = 15;
  const ROW = 30; // px per line of the strip under the map
  const hudRows = (width) => (width < 720 ? 2 : 1); // narrow pictures (every GIF) get two lines
  const hudHeight = (width) => hudRows(width) * ROW + 4;

  let gameId = null;
  let frames = []; // { tick, blob, stats }
  let size = { w: 0, h: 0 };
  let every = 30;
  const listeners = new Set();

  function reset(id) {
    gameId = id;
    frames = [];
    every = 30;
    document.documentElement.dataset.ofrLapseEvery = String(every);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.__ofr !== "lapse-frame") return;
    if (typeof m.gameId !== "string" || !/^[A-Za-z0-9]{4,16}$/.test(m.gameId)) return;
    if (!(m.blob instanceof Blob) || m.blob.size > 400000 || !/^image\/(webp|png)$/.test(m.blob.type)) return;
    if (!Number.isInteger(m.tick) || !(m.w > 0 && m.w <= 1024) || !(m.h > 0 && m.h <= 1024)) return;
    if (m.gameId !== gameId) reset(m.gameId);
    if (frames.length && m.tick <= frames[frames.length - 1].tick) return;
    size = { w: m.w, h: m.h };
    const s = m.stats && typeof m.stats === "object" ? m.stats : {};
    frames.push({
      tick: m.tick,
      blob: m.blob,
      w: m.w,
      h: m.h,
      stats: {
        seconds: Number(s.seconds) || Math.round(m.tick / 10),
        aliveHumans: Number.isFinite(s.aliveHumans) ? s.aliveHumans : null,
        myShare: Number.isFinite(s.myShare) ? s.myShare : null,
        map: String(s.map ?? "").slice(0, 40),
        top: (Array.isArray(s.top) ? s.top : []).slice(0, 3).map((t) => ({
          name: String(t?.name ?? "").slice(0, 32),
          share: Number(t?.share) || 0,
          rgb: Array.isArray(t?.rgb) ? t.rgb.slice(0, 3).map((c) => Math.max(0, Math.min(255, Number(c) || 0))) : [150, 150, 150],
          me: t?.me === true,
        })),
      },
    });
    if (frames.length > MAX_FRAMES) {
      frames = frames.filter((_, i) => i % 2 === 0);
      every *= 2;
      document.documentElement.dataset.ofrLapseEvery = String(every);
    }
    for (const fn of listeners) fn(frames.length);
  });

  const mmss = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
  const pct = (share) => `${(100 * share).toFixed(share < 0.1 ? 1 : 0)}%`;

  // One frame onto a canvas: the map, then a strip with the clock, players left,
  // your share and the three biggest empires.
  function paint(ctx, bitmap, frame, scale, opts) {
    const W = ctx.canvas.width;
    const rows = hudRows(W);
    const mapH = ctx.canvas.height - hudHeight(W);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, W, ctx.canvas.height);
    ctx.drawImage(bitmap, 0, 0, frame.w * scale, frame.h * scale);
    const s = frame.stats;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let x = 10;
    let y = mapH + 2 + ROW / 2;
    const put = (text, colour, gap = 14) => {
      ctx.fillStyle = colour;
      ctx.fillText(text, x, y);
      x += ctx.measureText(text).width + gap;
    };
    // text that must fit in `room` px: cut with an ellipsis until it does
    const fit = (text, room) => {
      let out = text;
      while (out.length > 1 && ctx.measureText(out).width > room) out = `${out.slice(0, -2)}…`;
      return out;
    };

    // line 1: clock, humans still alive, your share - and the credit, if there is room
    ctx.font = "700 15px system-ui, sans-serif";
    put(mmss(s.seconds), "#fcd34d");
    if (s.aliveHumans != null) put(`${s.aliveHumans} ${s.aliveHumans === 1 ? "human" : "humans"}`, "#9ca3af");
    if (s.myShare != null) put(`you ${pct(s.myShare)}`, "#e5e7eb");

    // the three biggest empires: after the rest on a wide picture, on their own line otherwise
    ctx.font = "600 13px system-ui, sans-serif";
    const credit = "OpenFront Pro · unofficial";
    ctx.font = "600 11px system-ui, sans-serif";
    const creditW = ctx.measureText(credit).width;
    const drawCredit = (from) => {
      if (W - 8 - creditW < from + 6) return false;
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.fillStyle = "#6b7280";
      ctx.textAlign = "right";
      ctx.fillText(credit, W - 8, y);
      ctx.textAlign = "left";
      return true;
    };
    let right = W - 10;
    if (rows === 2) {
      drawCredit(x);
      x = 10;
      y += ROW;
    } else if (drawCredit(x + 3 * 150)) right = W - 8 - creditW - 12;
    ctx.font = "600 13px system-ui, sans-serif";
    const top = s.top.filter((t) => t.share > 0);
    const slot = top.length ? (right - x) / top.length : 0;
    for (const t of top) {
      const from = x;
      ctx.fillStyle = `rgb(${t.rgb.join(",")})`;
      ctx.fillRect(x, y - 6, 12, 12);
      x += 17;
      const share = pct(t.share);
      const who = t.me ? "you" : opts.streamer ? "" : t.name;
      const room = slot - 17 - 14 - ctx.measureText(` ${share}`).width;
      put(`${fit(who, Math.max(20, room))} ${share}`.trim(), "#cbd5e1");
      x = Math.max(x, Math.min(from + slot, x)); // never run into the next slot
      if (x > right) break;
    }
  }

  // maxScale 2 for exports (a sharp picture on Discord); the in-recap preview
  // uses 1, so its stats strip is drawn at a size that stays legible when the
  // canvas is shrunk to the panel's width.
  function stage(w = size.w, h = size.h, maxScale = 2) {
    const scale = Math.max(1, Math.min(maxScale, Math.floor(960 / Math.max(1, w))));
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale + hudHeight(canvas.width);
    return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), scale };
  }

  // The frames of one game, as they are now. `id` guards against a recap that is
  // still open when the next game has started recording.
  function snapshot(id) {
    if (id && id !== gameId) throw new Error("this game's timelapse is gone (a newer game is recording)");
    const list = [...frames];
    if (list.length < 2) throw new Error("not enough frames");
    const last = list[list.length - 1];
    return { list: list.filter((f) => f.w === last.w && f.h === last.h), w: last.w, h: last.h };
  }

  // Looping preview inside the recap.
  function player(opts = {}) {
    const first = frames[frames.length - 1];
    const { canvas, ctx, scale } = stage(first?.w ?? size.w, first?.h ?? size.h, 1);
    canvas.className = "ofr-lapse-canvas";
    let i = 0;
    let stopped = false;
    let timer = null;
    const step = async () => {
      if (stopped || !canvas.isConnected) return;
      if (opts.gameId && opts.gameId !== gameId) return; // another game is recording now: keep the last picture
      if (document.hidden || canvas.offsetParent === null) {
        timer = setTimeout(step, 500); // hidden tab or folded recap
        return;
      }
      const list = frames.filter((f) => f.w * scale === canvas.width); // frames of the size this canvas was made for
      if (list.length) {
        const frame = list[i % list.length];
        try {
          const bmp = await createImageBitmap(frame.blob);
          paint(ctx, bmp, frame, scale, opts);
          bmp.close();
        } catch {
          // an undecodable frame is skipped
        }
        i = (i + 1) % list.length;
      }
      timer = setTimeout(step, i === 0 ? 1200 : 1000 / FPS); // pause on the last frame
    };
    // start once it is in the document
    requestAnimationFrame(() => setTimeout(step, 50));
    return { canvas, stop: () => { stopped = true; clearTimeout(timer); } };
  }

  // ---- WebM --------------------------------------------------------------------------------
  async function toWebM({ gameId: id = null, endCard = null, onProgress = () => {}, streamer = false } = {}) {
    const { list, w, h } = snapshot(id);
    const { canvas, ctx, scale } = stage(w, h);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) throw new Error("this browser cannot record WebM");
    const stream = canvas.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => (rec.onstop = resolve));
    // Paused while the tab is hidden: the recorder stamps frames with wall time and
    // hidden tabs get throttled timers, so the video would come out slowed down.
    let wake = null;
    const onVisibility = () => {
      if (document.hidden) {
        if (rec.state === "recording") rec.pause();
      } else {
        if (rec.state === "paused") rec.resume();
        wake?.();
        wake = null;
      }
    };
    const wait = async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      while (document.hidden) await new Promise((r) => (wake = r));
    };
    document.addEventListener("visibilitychange", onVisibility);
    try {
      rec.start();
      if (document.hidden) rec.pause();
      for (let i = 0; i < list.length; i++) {
        const bmp = await createImageBitmap(list[i].blob);
        paint(ctx, bmp, list[i], scale, { streamer });
        bmp.close();
        onProgress((i + 1) / (list.length + (endCard ? FPS * 3 : FPS)));
        await wait(1000 / FPS);
      }
      await wait(1000); // hold the last frame
      if (endCard) {
        // the recap's share card, letterboxed, for three seconds
        ctx.fillStyle = "#0b0d12";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const k = Math.min(canvas.width / endCard.width, canvas.height / endCard.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(endCard, (canvas.width - endCard.width * k) / 2, (canvas.height - endCard.height * k) / 2, endCard.width * k, endCard.height * k);
        for (let t = 0; t < 30; t++) {
          // MediaRecorder only emits frames when the canvas changes
          ctx.fillStyle = t % 2 ? "rgba(0,0,0,0.004)" : "rgba(255,255,255,0.004)";
          ctx.fillRect(0, 0, 1, 1);
          await wait(100);
        }
      }
    } finally {
      document.removeEventListener("visibilitychange", onVisibility);
      if (rec.state !== "inactive") rec.stop();
      await done;
      for (const track of stream.getTracks()) track.stop();
    }
    return new Blob(chunks, { type: "video/webm" });
  }

  // ---- GIF (GIF89a, one global palette, LZW, delta frames) ---------------------------------
  // The pictures are flat colours (territories + a terrain ramp), so a palette
  // of the 255 most common 5-bit-per-channel colours loses almost nothing. Index
  // 255 is "transparent": from the second frame on, only the box that changed is
  // stored, and inside it every pixel that did not change is transparent - a map
  // changes along its borders, so this is most of the file size.
  const TRANSPARENT = 255;

  // Incremental writer over already-indexed frames (Uint8Array, W*H, values 0-254).
  function gifWriter(W, H, palette) {
    const out = [];
    const bytes = (...b) => out.push(Uint8Array.from(b));
    const u16 = (n) => [n & 255, (n >> 8) & 255];
    const ascii = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    out.push(ascii("GIF89a"));
    bytes(...u16(W), ...u16(H), 0xf7, 0, 0); // global palette, 256 colours
    const table = new Uint8Array(768);
    palette.slice(0, 256).forEach((c, i) => table.set(c, i * 3));
    out.push(table);
    bytes(0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop forever
    let prev = null;
    return {
      add(idx, delay) {
        let x0 = 0;
        let y0 = 0;
        let x1 = W - 1;
        let y1 = H - 1;
        let data = idx;
        if (prev) {
          x0 = W;
          y0 = H;
          x1 = -1;
          y1 = -1;
          for (let y = 0, i = 0; y < H; y++) {
            for (let x = 0; x < W; x++, i++) {
              if (idx[i] === prev[i]) continue;
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
          if (x1 < 0) x0 = y0 = x1 = y1 = 0; // nothing changed: one transparent pixel carries the delay
          const w = x1 - x0 + 1;
          const h = y1 - y0 + 1;
          data = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) {
            const row = (y0 + y) * W + x0;
            for (let x = 0; x < w; x++) data[y * w + x] = idx[row + x] === prev[row + x] ? TRANSPARENT : idx[row + x];
          }
        }
        // graphic control: keep what is there (disposal 1); transparency from frame two on
        bytes(0x21, 0xf9, 4, prev ? 0x05 : 0x04, ...u16(delay), TRANSPARENT, 0);
        bytes(0x2c, ...u16(x0), ...u16(y0), ...u16(x1 - x0 + 1), ...u16(y1 - y0 + 1), 0);
        out.push(lzw(data));
        prev = idx;
      },
      finish() {
        bytes(0x3b);
        return out;
      },
    };
  }

  async function toGif({ gameId: id = null, onProgress = () => {}, streamer = false, maxFrames = 150 } = {}) {
    const shot = snapshot(id);
    let list = shot.list;
    if (list.length > maxFrames) list = Array.from({ length: maxFrames }, (_, k) => list[Math.round((k * (list.length - 1)) / (maxFrames - 1))]); // the last one is the end of the game
    const { canvas, ctx } = stage(shot.w, shot.h);
    const scale = 1; // GIFs get big fast: native frame size
    canvas.width = shot.w;
    canvas.height = shot.h + hudHeight(shot.w);
    const W = canvas.width;
    const H = canvas.height;

    // pass 1: histogram over a sample of frames
    const hist = new Map();
    const sample = list.filter((_, i) => i % Math.max(1, Math.floor(list.length / 12)) === 0);
    for (const f of sample) {
      const bmp = await createImageBitmap(f.blob);
      paint(ctx, bmp, f, scale, { streamer });
      bmp.close();
      const d = ctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        hist.set(key, (hist.get(key) ?? 0) + 1);
      }
    }
    const COLOURS = 255; // index 255 is the transparent one
    const palette = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, COLOURS).map(([k]) => [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4]);
    const used = palette.length;
    while (palette.length < 256) palette.push([0, 0, 0]);
    const nearest = new Map();
    const indexOf = (r, g, b) => {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const hit = nearest.get(key);
      if (hit !== undefined) return hit;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < used; i++) {
        const p = palette[i];
        const dist = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
      nearest.set(key, best);
      return best;
    };

    const gif = gifWriter(W, H, palette);
    for (let n = 0; n < list.length; n++) {
      const bmp = await createImageBitmap(list[n].blob);
      paint(ctx, bmp, list[n], scale, { streamer });
      bmp.close();
      const d = ctx.getImageData(0, 0, W, H).data;
      const idx = new Uint8Array(W * H);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) idx[j] = indexOf(d[i], d[i + 1], d[i + 2]);
      gif.add(idx, n === list.length - 1 ? 150 : 8); // hundredths of a second
      onProgress((n + 1) / list.length);
      if (n % 5 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the page alive
    }
    return new Blob(gif.finish(), { type: "image/gif" });
  }

  // GIF's variable-width LZW, 8-bit input, sub-blocks of at most 255 bytes.
  function lzw(pixels, info = null) {
    const MIN = 8;
    const CLEAR = 1 << MIN;
    const END = CLEAR + 1;
    const buf = [];
    let cur = 0;
    let bits = 0;
    let width = MIN + 1;
    const emit = (code) => {
      cur |= code << bits;
      bits += width;
      while (bits >= 8) {
        buf.push(cur & 255);
        cur >>>= 8;
        bits -= 8;
      }
    };
    let dict = new Map();
    let next = END + 1;
    emit(CLEAR);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        dict.set(key, next++);
        if (next > 1 << width && width < 12) width++;
      } else {
        emit(CLEAR);
        dict = new Map();
        next = END + 1;
        width = MIN + 1;
      }
      prefix = k;
    }
    emit(prefix);
    if (next === 1 << width && width < 12) width++; // the decoder adds one more entry on reading `prefix`
    if (info) info.endWidth = width; // tools/test-gif.mjs
    emit(END);
    if (bits > 0) buf.push(cur & 255);
    const out = new Uint8Array(1 + buf.length + Math.ceil(buf.length / 255) + 1);
    let o = 0;
    out[o++] = MIN;
    for (let i = 0; i < buf.length; i += 255) {
      const n = Math.min(255, buf.length - i);
      out[o++] = n;
      for (let j = 0; j < n; j++) out[o++] = buf[i + j];
    }
    out[o++] = 0;
    return out.subarray(0, o);
  }

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  globalThis.OFR_LAPSE = {
    count: (id) => (id && id !== gameId ? 0 : frames.length),
    gameId: () => gameId,
    seconds: () => (frames.length ? frames[frames.length - 1].stats.seconds : 0),
    onFrame: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    player,
    toWebM,
    toGif,
    save,
    _lzw: lzw, // for tools/test-gif.mjs
    _gifWriter: gifWriter,
  };
})();
