// "Open anything": recognise files by content, and show images and PDFs as sheets in the 3D scene.
import * as THREE from 'three';

export const MODEL_EXT = ['usd', 'usda', 'usdc', 'usdz', 'gltf', 'glb', 'dae', 'obj', 'fbx', 'stl', 'ply', '3mf', 'wrl',
  '3ds', 'pcd', 'xyz', 'amf', 'kmz'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'tif', 'tiff'];
export const HDR_EXT = ['exr', 'hdr'];
export const extOf = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');

const latin1 = new TextDecoder('latin1');

/** Guess a file's real type from its first bytes (used when the extension is missing or unknown). */
export async function sniffExt(file) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (!head.length) return '';
  const text = latin1.decode(head);
  const starts = (t) => text.startsWith(t);
  const b = (...v) => v.every((x, i) => head[i] === x);
  // images / documents
  if (b(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (b(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts('GIF8')) return 'gif';
  if (starts('RIFF') && text.slice(8, 12) === 'WEBP') return 'webp';
  if (starts('BM') && head.length > 14 && !/^[\x20-\x7e\s]{40}/.test(text)) return 'bmp';
  if (starts('%PDF')) return 'pdf';
  if (b(0x49, 0x49, 0x2a, 0x00) || b(0x4d, 0x4d, 0x00, 0x2a)) return 'tif';      // TIFF (little / big endian)
  if (b(0x76, 0x2f, 0x31, 0x01)) return 'exr';
  if (starts('#?RADIANCE') || starts('#?RGBE')) return 'hdr';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'svg';
  // 3D
  if (starts('PXR-USDC')) return 'usdc';
  if (starts('#usda')) return 'usda';
  if (starts('glTF')) return 'glb';
  if (/^\s*\{/.test(text) && /"asset"\s*:/.test(text)) return 'gltf';
  if (starts('Kaydara FBX')) return 'fbx';
  if (/<COLLADA/i.test(text)) return 'dae';
  if (/<amf[\s>]/i.test(text)) return 'amf';
  if (starts('ply')) return 'ply';
  if (/^(#\s*\.PCD|VERSION\s)/m.test(text) && /FIELDS\s/.test(text)) return 'pcd';
  if (starts('#VRML') || starts('#X3D')) return 'wrl';
  if (starts('solid') && /facet|endsolid/.test(text)) return 'stl';
  if (head.length >= 84 && file.size === 84 + 50 * new DataView(head.buffer).getUint32(80, true)) return 'stl';
  if (b(0x4d, 0x4d) && head.length > 6 && new DataView(head.buffer).getUint32(2, true) <= file.size) return '3ds';
  if (b(0x50, 0x4b, 0x03, 0x04)) return 'zip';
  const printable = !/[\x00-\x08\x0e-\x1f]/.test(text);
  if (printable && /^(v|vn|vt|f|o|g|s|mtllib|usemtl)\s/m.test(text) && /^v\s+[-\d.]/m.test(text)) return 'obj';
  if (printable) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, 20);
    if (lines.length >= 3 && lines.every((l) => /^\s*-?[\d.]+(e[-+]?\d+)?([\s,;]+-?[\d.]+(e[-+]?\d+)?){2,}\s*$/i.test(l))) return 'xyz';
  }
  return '';
}

/** kind: '3d' | 'image' | 'hdr' | 'pdf' | 'zip' | 'unknown', plus the effective extension. */
export async function classify(file) {
  let ext = extOf(file.name);
  const known = (e) => MODEL_EXT.includes(e) || IMAGE_EXT.includes(e) || HDR_EXT.includes(e) || e === 'pdf' || e === 'zip';
  if (!known(ext)) ext = await sniffExt(file);
  const kind = ext === 'zip' ? 'zip' : MODEL_EXT.includes(ext) ? '3d' : IMAGE_EXT.includes(ext) ? 'image'
    : HDR_EXT.includes(ext) ? 'hdr' : ext === 'pdf' ? 'pdf' : 'unknown';
  return { kind, ext };
}

// ---------------------------------------------------------------- sheets (images / pdf pages)
const SHEET_LONG_SIDE = 0.3;     // metres

function sheetFromCanvas(canvas, name) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const w = canvas.width, h = canvas.height, s = SHEET_LONG_SIDE / Math.max(w, h);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * s, h * s),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, toneMapped: false }));
  mesh.name = name; mesh.userData.sheet = true; mesh.userData.px = [w, h];
  return mesh;
}

function layoutRow(group, sheets) {
  const gap = 0.02; let x = 0;
  const total = sheets.reduce((a, m) => a + m.geometry.parameters.width, 0) + gap * (sheets.length - 1);
  x = -total / 2;
  for (const m of sheets) {
    const w = m.geometry.parameters.width;
    m.position.set(x + w / 2, 0, 0); x += w + gap; group.add(m);
  }
}

const isTiff = (file) => /\.tiff?$/i.test(file.name) || file.kext === 'tif' || file.kext === 'tiff';

/** Decode a TIFF (browsers cannot) into a canvas, downscaled so the longest side is at most `maxSide`. */
export async function decodeTiff(file, maxSide = 4096) {
  const UTIF = (await import('three/examples/jsm/libs/utif.module.js')).default;
  // The inflate bundled with this TIFF reader decodes ZIP/deflate TIFFs (Photoshop's "ZIP" option) wrongly, leaving most of the
  // picture black. The standard inflate fixes every deflate variant (prediction filter, 16-bit, tiled, CMYK).
  const { inflateSync } = await import('three/examples/jsm/libs/fflate.module.js');
  UTIF._inflateRaw = (src) => inflateSync(src);
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error('empty TIFF');
  const ifd = ifds.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), ifds[0]);   // the biggest page
  UTIF.decodeImage(buf, ifd, ifds);
  const rgba = UTIF.toRGBA8(ifd), w = ifd.width, h = ifd.height;
  const full = document.createElement('canvas'); full.width = w; full.height = h;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
  const k = Math.min(1, maxSide / Math.max(w, h));
  if (k === 1) return full;
  const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(w * k)); out.height = Math.max(1, Math.round(h * k));
  const octx = out.getContext('2d'); octx.imageSmoothingQuality = 'high'; octx.drawImage(full, 0, 0, out.width, out.height);
  return out;
}

async function canvasFromImageFile(file, maxSide = 4096) {
  if (isTiff(file)) return decodeTiff(file, maxSide);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('cannot decode image')); img.src = url; });
    let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;            // svg may report 0 -> fallback
    const k = Math.min(1, maxSide / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

export async function buildImageSheets(entries) {            // entries: [{file, kind, ext}]
  const group = new THREE.Group(); const sheets = []; const notes = [];
  for (const { file, kind } of entries.slice(0, 24)) {
    if (kind === 'hdr') {
      const url = URL.createObjectURL(file);
      try {
        const mod = extOf(file.name) === 'exr' || (await sniffExt(file)) === 'exr'
          ? (await import('three/examples/jsm/loaders/EXRLoader.js')).EXRLoader
          : (await import('three/examples/jsm/loaders/HDRLoader.js')).HDRLoader;
        const tex = await new mod().loadAsync(url);
        const { width: w, height: h } = tex.image, s = SHEET_LONG_SIDE / Math.max(w, h);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * s, h * s),
          new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
        mesh.name = file.name; mesh.userData.sheet = true; mesh.userData.px = [w, h]; sheets.push(mesh);
        notes.push('HDR image (tone-mapped)');
      } finally { URL.revokeObjectURL(url); }
    } else sheets.push(sheetFromCanvas(await canvasFromImageFile(file), file.name));
  }
  layoutRow(group, sheets);
  if (entries.length > 24) notes.push(`showing the first 24 of ${entries.length} images`);
  group.userData.notes = ['Shown as flat sheets in 3D', ...notes];
  return group;
}

export async function buildPdfSheets(file, maxPages = 30) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const n = Math.min(doc.numPages, maxPages), sheets = [];
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2048 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    sheets.push(sheetFromCanvas(canvas, `page ${p}`));
  }
  const group = new THREE.Group(); layoutRow(group, sheets);
  group.userData.notes = [`PDF · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''} shown as flat sheets`,
    ...(doc.numPages > n ? [`showing the first ${n}`] : [])];
  return group;
}
