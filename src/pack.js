// "Pack to can": wrap front-of-pack / back-of-pack pictures onto a can, projecting each picture onto its side the way a
// pack shot is photographed (front picture on the front half, back picture on the back half).
import * as THREE from 'three';
import { decodeTiff } from './anyfile.js';
import { CONTAINERS, containerProfile } from './containers.js';

const isBg = (d, i) => d[i + 3] < 24 || (d[i] > 242 && d[i + 1] > 242 && d[i + 2] > 242);

async function loadCanvas(file, maxSide = 2048) {
  if (/\.tiff?$/i.test(file.name) || file.kext === 'tif' || file.kext === 'tiff') return decodeTiff(file, maxSide);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('cannot decode ' + file.name)); img.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

/** Remove the backdrop (white or transparent area connected to the picture's border) and crop to the pack silhouette. */
function cutOut(canvas) {
  const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d');
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  const bg = new Uint8Array(w * h);
  const stack = new Int32Array(w * h); let sp = 0;
  const push = (x, y) => { const p = y * w + x; if (!bg[p] && isBg(d, p * 4)) { bg[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (sp) {
    const p = stack[--sp], x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  // one pixel of erosion removes the pale anti-aliasing halo around the silhouette
  const edge = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    if (!bg[p] && (bg[p - 1] || bg[p + 1] || bg[p - w] || bg[p + w]) && d[p * 4] + d[p * 4 + 1] + d[p * 4 + 2] > 600) edge.push(p);
  }
  for (const p of edge) bg[p] = 1;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!bg[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) throw new Error('the picture looks empty');
  for (let p = 0; p < w * h; p++) if (bg[p]) d[p * 4 + 3] = 0;
  ctx.putImageData(im, 0, 0);
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  const octx = out.getContext('2d');
  octx.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  // Extend every row's edge colour outward so the picture has no holes: where the model is a little wider than the
  // photographed silhouette (neck, rims) it shows the silhouette's edge colour (e.g. silver) instead of a gap.
  const cw = out.width, ch = out.height, im2 = octx.getImageData(0, 0, cw, ch), q = im2.data;
  const firstLast = new Int32Array(ch * 2).fill(-1);
  for (let y = 0; y < ch; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < cw; x++) if (q[(y * cw + x) * 4 + 3] > 128) { if (a < 0) a = x; b = x; }
    firstLast[y * 2] = a; firstLast[y * 2 + 1] = b;
  }
  for (let y = 0; y < ch; y++) {
    let ys = y;
    if (firstLast[y * 2] < 0) {                                  // a row with no picture: borrow the nearest row that has one
      let up = y, dn = y;
      while (up >= 0 && firstLast[up * 2] < 0) up--;
      while (dn < ch && firstLast[dn * 2] < 0) dn++;
      ys = up >= 0 && (dn >= ch || y - up <= dn - y) ? up : dn;
      if (ys < 0 || ys >= ch) continue;
    }
    const a = firstLast[ys * 2], b = firstLast[ys * 2 + 1];
    const l = (ys * cw + a) * 4, r = (ys * cw + b) * 4;
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      if (x < a || x > b || firstLast[y * 2] < 0) {
        const src = x < a || firstLast[y * 2] < 0 && x < (cw >> 1) ? l : r;
        q[i] = q[src]; q[i + 1] = q[src + 1]; q[i + 2] = q[src + 2];
      }
      q[i + 3] = 255;
    }
  }
  octx.putImageData(im2, 0, 0);
  return out;
}

/** A plain back made from the front picture: every row filled with that row's edge colour (keeps the silver rims). */
function plainBack(front) {
  const w = front.width, h = front.height, ctx = front.getContext('2d');
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const octx = out.getContext('2d'); const im = octx.createImageData(w, h), d = im.data;
  for (let y = 0; y < h; y++) {
    const opaque = []; for (let x = 0; x < w; x++) if (src[(y * w + x) * 4 + 3] > 128) opaque.push(x);
    if (!opaque.length) continue;
    const take = Math.max(1, Math.min(8, opaque.length >> 3)); const pick = [...opaque.slice(0, take), ...opaque.slice(-take)];
    let r = 0, g = 0, b = 0; for (const x of pick) { const i = (y * w + x) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; }
    r /= pick.length; g /= pick.length; b /= pick.length;
    for (const x of opaque) { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  }
  octx.putImageData(im, 0, 0);
  return out;
}

/** One half (front = +Z side, back = -Z side) of the can with picture-projection UVs. */
function halfGeometry(geo, front, R, H) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, idx = geo.index;
  const P = [], N = [], UV = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (((pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3 >= 0) !== front) continue;
    for (const k of [a, b, c]) {
      const x = pos.getX(k), y = pos.getY(k);
      P.push(x, y, pos.getZ(k)); N.push(nor.getX(k), nor.getY(k), nor.getZ(k));
      UV.push(front ? (x + R) / (2 * R) : (R - x) / (2 * R), y / H);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  return g;
}

function printedMaterial(canvas) {
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  return new THREE.MeshPhysicalMaterial({
    map, metalness: 0.25, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.25,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
}

/** front/back: image Files (either may be missing). size: 'auto' or a key of CONTAINERS. */
export async function buildPackCan({ front, back, size = 'auto' }) {
  if (!front && !back) throw new Error('no picture to put on the can');
  const fc = front ? cutOut(await loadCanvas(front)) : null;
  const bc = back ? cutOut(await loadCanvas(back)) : null;
  const ref = fc || bc;
  let id = 'can330', D = 0.066, H = 0.115;
  if (CONTAINERS[size]) { id = size; D = CONTAINERS[size].D; H = CONTAINERS[size].H; }
  else {                                                      // match the picture's proportions; tall pictures are bottles
    const ratio = ref.height / ref.width;
    if (ratio > 2.75) { id = 'pet500'; D = 0.065; }
    H = D * (ratio >= 1.2 && ratio <= 5 ? ratio : 1.74);
  }
  const R = D / 2, bottle = CONTAINERS[id].kind !== 'can';
  const geo = new THREE.LatheGeometry(containerProfile(id, R, H), 160);
  const group = new THREE.Group();
  const base = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.28, side: THREE.DoubleSide }));
  base.name = bottle ? 'bottle body' : 'can body (aluminium)'; group.add(base);
  const add = (isFront, canvas, name) => {
    const m = new THREE.Mesh(halfGeometry(geo, isFront, R, H), printedMaterial(canvas));
    m.name = name; m.renderOrder = 1; group.add(m);
  };
  add(true, fc || plainBack(bc), fc ? 'front of pack' : 'front (plain)');
  add(false, bc || plainBack(fc), bc ? 'back of pack' : 'back (plain)');
  group.userData.notes = [];
  return group;
}

// whole words only: `back_of_pack` counts, but BOPP (a label film) is not "bop" and "feedback" is not "back"
export const PACK_FRONT = /(?<![a-z])(front|fop)(?![a-z])/i, PACK_BACK = /(?<![a-z])(back|bop|rear)(?![a-z])/i;

/** Which dropped pictures are the front and the back of pack. */
export function assignPack(imgs) {
  const isBack = (f) => PACK_BACK.test(f.name), isFront = (f) => PACK_FRONT.test(f.name);
  let back = imgs.find(isBack), front = imgs.find(isFront);
  if (!front) front = imgs.find((f) => f !== back) || null;
  if (!back) back = imgs.find((f) => f !== front && !isFront(f)) || null;
  return { front, back };
}
export const looksLikePack = (imgs) => imgs.some((f) => /front|back|fop|bop|pack|\bcan\b|label|gs1|\d\s?(ml|cl)\b|\d\s?l\b/i.test(f.name));
