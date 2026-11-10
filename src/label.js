// Find the printed label on a flat artwork approval sheet (dimension lines, specs, swatches around it), and a small editor
// to correct the box by hand.

/** Detect the label: the biggest block of saturated colour once thin lines, text and small swatches are removed. */
export function detectLabel(canvas) {
  const W = canvas.width, Hh = canvas.height;
  const k = Math.min(1, 640 / Math.max(W, Hh));
  const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(Hh * k));
  const work = document.createElement('canvas'); work.width = w; work.height = h;
  const wctx = work.getContext('2d', { willReadFrequently: true }); wctx.imageSmoothingQuality = 'high';
  wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, w, h); wctx.drawImage(canvas, 0, 0, w, h);
  const d = wctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const r = d[p * 4], g = d[p * 4 + 1], b = d[p * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 40 && (mx - mn) / mx > 0.30) mask[p] = 1;                    // coloured (not white, grey or black)
  }
  const box = (src, r) => {                                              // 1 where any pixel within r is set (dilate)
    const out = new Uint8Array(w * h), I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      if (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0] > 0) out[y * w + x] = 1;
    }
    return out;
  };
  // opening: drop thin features (dimension lines, tick marks, outlines) so only thick colour areas remain
  const inv = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) inv[p] = mask[p] ? 0 : 1;
  const eroded = box(inv, 2); for (let p = 0; p < w * h; p++) eroded[p] = eroded[p] ? 0 : 1;
  const opened = box(eroded, 2); for (let p = 0; p < w * h; p++) mask[p] = opened[p] && 1;
  const dil = box(mask, Math.max(3, Math.round(0.006 * Math.max(w, h))));  // joins the label's parts across text and logos
  // connected components of the dilated mask; pick the one with the most coloured pixels
  const lab = new Int32Array(w * h), count = [0]; let n = 0;
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!dil[s] || lab[s]) continue;
    n++; count[n] = 0; let sp = 0; stack[sp++] = s; lab[s] = n;
    while (sp) {
      const p = stack[--sp]; if (mask[p]) count[n]++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && dil[p - 1] && !lab[p - 1]) { lab[p - 1] = n; stack[sp++] = p - 1; }
      if (x < w - 1 && dil[p + 1] && !lab[p + 1]) { lab[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && dil[p - w] && !lab[p - w]) { lab[p - w] = n; stack[sp++] = p - w; }
      if (y < h - 1 && dil[p + w] && !lab[p + w]) { lab[p + w] = n; stack[sp++] = p + w; }
    }
  }
  let best = 0; for (let i = 1; i <= n; i++) if (count[i] > count[best]) best = i;
  const full = { x: 0, y: 0, w: W, h: Hh };
  if (!best || count[best] < 0.004 * w * h) return { rect: full, conf: 0, areaRatio: 1, dominant: [200, 200, 200] };
  let x0 = w, y0 = h, x1 = -1, y1 = -1, rs = 0, gs = 0, bs = 0, cn = 0;
  for (let p = 0; p < w * h; p++) {
    if (lab[p] !== best || !mask[p]) continue;
    const x = p % w, y = (p / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    rs += d[p * 4]; gs += d[p * 4 + 1]; bs += d[p * 4 + 2]; cn++;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const rect = { x: Math.round(x0 / k), y: Math.round(y0 / k), w: Math.min(W, Math.round(bw / k)), h: Math.min(Hh, Math.round(bh / k)) };
  const conf = Math.min(1, count[best] / Math.max(1, bw * bh) * 1.2);                // how fully the box is filled with colour
  return { rect, conf, areaRatio: (bw * bh) / (w * h), dominant: [Math.round(rs / cn), Math.round(gs / cn), Math.round(bs / cn)] };
}

/** A pack-shot (one container photographed on white) vs an artwork sheet (flat label among annotations). */
export function looksLikePackShot(det) {
  const { rect, conf, areaRatio } = det;
  const tall = rect.h / Math.max(1, rect.w);
  return conf > 0.45 && tall >= 1.2 && tall <= 5 && areaRatio > 0.18;
}

export function cropCanvas(canvas, rect) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(rect.w)); out.height = Math.max(1, Math.round(rect.h));
  out.getContext('2d').drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height);
  return out;
}

/** Overlay editor: drag the box edges/corners (or the whole box) over the sheet. Resolves with a rect, or null if cancelled. */
export function editLabelRect(canvas, rect) {
  const root = document.getElementById('labelEditor'), cv = document.getElementById('leCanvas');
  const ok = document.getElementById('leOk'), cancel = document.getElementById('leCancel');
  const maxW = Math.min(window.innerWidth * 0.86, 1100), maxH = window.innerHeight * 0.66;
  const s = Math.min(maxW / canvas.width, maxH / canvas.height);
  cv.width = Math.round(canvas.width * s); cv.height = Math.round(canvas.height * s);
  const ctx = cv.getContext('2d');
  let r = { ...rect };
  const draw = () => {
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(canvas, 0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(canvas, r.x, r.y, r.w, r.h, r.x * s, r.y * s, r.w * s, r.h * s);
    ctx.strokeStyle = '#4f9cff'; ctx.lineWidth = 2; ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
    ctx.fillStyle = '#4f9cff';
    for (const [cx, cy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) ctx.fillRect(cx * s - 5, cy * s - 5, 10, 10);
  };
  root.hidden = false; draw();
  return new Promise((resolve) => {
    let mode = null, start = null;
    const pos = (e) => { const b = cv.getBoundingClientRect(); return { x: (e.clientX - b.left) / b.width * canvas.width, y: (e.clientY - b.top) / b.height * canvas.height }; };
    const T = 12 / s;                                                         // grab distance in image pixels
    const hit = (p) => {
      const l = Math.abs(p.x - r.x) < T, rt = Math.abs(p.x - (r.x + r.w)) < T, t = Math.abs(p.y - r.y) < T, b = Math.abs(p.y - (r.y + r.h)) < T;
      const inX = p.x > r.x - T && p.x < r.x + r.w + T, inY = p.y > r.y - T && p.y < r.y + r.h + T;
      return { l: l && inY, r: rt && inY, t: t && inX, b: b && inX, move: p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h };
    };
    const down = (e) => { const p = pos(e), h = hit(p); mode = h.l || h.r || h.t || h.b ? h : h.move ? { move: true } : null; start = { p, r: { ...r } }; cv.setPointerCapture(e.pointerId); };
    const mv = (e) => {
      const p = pos(e);
      if (!mode) { const h = hit(p); cv.style.cursor = (h.l || h.r) && (h.t || h.b) ? 'nwse-resize' : h.l || h.r ? 'ew-resize' : h.t || h.b ? 'ns-resize' : h.move ? 'move' : 'default'; return; }
      const dx = p.x - start.p.x, dy = p.y - start.p.y, o = start.r;
      let { x, y, w, h } = o;
      if (mode.move) { x = o.x + dx; y = o.y + dy; }
      else { if (mode.l) { x = o.x + dx; w = o.w - dx; } if (mode.r) w = o.w + dx; if (mode.t) { y = o.y + dy; h = o.h - dy; } if (mode.b) h = o.h + dy; }
      w = Math.max(20, w); h = Math.max(20, h);
      x = Math.min(Math.max(0, x), canvas.width - w); y = Math.min(Math.max(0, y), canvas.height - h);
      r = { x, y, w: Math.min(w, canvas.width), h: Math.min(h, canvas.height) }; draw();
    };
    const up = () => { mode = null; };
    const done = (val) => { cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); root.hidden = true; resolve(val); };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
    ok.onclick = () => done(r); cancel.onclick = () => done(null);
  });
}
