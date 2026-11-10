// Roll a flat label (cropped from an artwork sheet) around a default container: a printed can body, or a sleeve label on a
// PET / glass bottle, sized from the label's proportions.
import * as THREE from 'three';
import { CONTAINERS, containerParts, radiusAt } from './containers.js';

const SEG = 180;

export function labelZone(c, aspect, R, H, pos, hscale) {
  if (c.kind === 'can') return { y0: 0.0125, y1: H - 0.027, auto: true };           // printed all over the straight body
  const top = (c.kind === 'pet' ? 0.58 : 0.66) * H, bot = 0.05 * H;
  const circ = 2 * Math.PI * R * 0.985;                                              // the sleeve wraps the full circumference
  let hl = Math.min(circ / aspect * hscale, (top - bot) * 0.96);
  const yc = (pos ?? c.center) * H;
  let y0 = yc - hl / 2, y1 = yc + hl / 2;
  if (y1 > top) { y0 -= y1 - top; y1 = top; }
  if (y0 < bot) { y1 += bot - y0; y0 = bot; }
  return { y0, y1, auto: false };
}

function sleeveGeometry(body, y0, y1) {
  const rings = 32, P = [], N = [], UV = [], I = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings, y = y0 + (y1 - y0) * t, r = radiusAt(body, y) + 0.00035;
    for (let i = 0; i <= SEG; i++) {
      const a = 2 * Math.PI * i / SEG, sx = Math.sin(a), cz = Math.cos(a);
      P.push(r * sx, y, r * cz); N.push(sx, 0, cz); UV.push(i / SEG, t);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < SEG; i++) {
    const a = j * (SEG + 1) + i, b = a + 1, c = a + SEG + 1, d = c + 1;
    I.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

function scaled(canvas, maxW = 4096) {
  if (canvas.width <= maxW) return canvas;
  const k = maxW / canvas.width, out = document.createElement('canvas');
  out.width = maxW; out.height = Math.max(1, Math.round(canvas.height * k));
  const c = out.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** label: cropped canvas. id: container key. rot: degrees. pos: label centre as a fraction of height (bottles) or null. */
export function buildWrapped({ label, id, rot = 0, pos = null, hscale = 1, tint = [200, 200, 200] }) {
  const c = CONTAINERS[id], R = c.D / 2, H = c.H;
  const { body, cap } = containerParts(id, R, H);
  const group = new THREE.Group();
  const bodyMat = {
    can: new THREE.MeshPhysicalMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.28, side: THREE.DoubleSide }),
    pet: new THREE.MeshPhysicalMaterial({ color: 0xeef3f5, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08, transparent: true,
      opacity: 0.88, envMapIntensity: 1.3, side: THREE.DoubleSide }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xd5ecdc, roughness: 0.04, transparent: true, opacity: 0.32, envMapIntensity: 1.6,
      side: THREE.DoubleSide, depthWrite: false }),
  }[c.kind];
  const bodyMesh = new THREE.Mesh(new THREE.LatheGeometry(body, SEG), bodyMat);
  bodyMesh.name = c.kind === 'can' ? 'can body (aluminium)' : 'container body'; group.add(bodyMesh);
  if (c.kind === 'glass') {                                                        // dark cola inside the glass, up to the neck
    const inner = body.filter((p) => p.y <= 0.80 * H).map((p) => new THREE.Vector2(p.x * 0.93, p.y + 0.002));
    inner.push(new THREE.Vector2(0.28 * R, 0.80 * H), new THREE.Vector2(0, 0.80 * H));
    const liquid = new THREE.Mesh(new THREE.LatheGeometry(inner, SEG),
      new THREE.MeshPhysicalMaterial({ color: 0x2a1207, roughness: 0.1, clearcoat: 1, envMapIntensity: 0.8 }));
    liquid.name = 'liquid'; liquid.renderOrder = -1; group.add(liquid);
  }
  if (cap) {
    const col = new THREE.Color(`rgb(${tint[0]},${tint[1]},${tint[2]})`);
    const capMesh = new THREE.Mesh(new THREE.LatheGeometry(cap, 96),
      new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.35, metalness: 0.1, clearcoat: 0.6, side: THREE.DoubleSide }));
    capMesh.name = 'cap'; group.add(capMesh);
  }
  // the label sleeve
  const aspect = label.width / label.height;
  const z = labelZone(c, aspect, R, H, pos, hscale);
  const tex = new THREE.CanvasTexture(scaled(label));
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.offset.x = 0.5 - rot / 360;                                                  // centre of the label faces the front
  const printed = new THREE.Mesh(sleeveGeometry(body, z.y0, z.y1), new THREE.MeshPhysicalMaterial({
    map: tex, roughness: c.kind === 'can' ? 0.38 : 0.5, metalness: c.kind === 'can' ? 0.25 : 0,
    clearcoat: c.kind === 'can' ? 0.5 : 0.3, clearcoatRoughness: 0.3, side: THREE.FrontSide,      // outer face only: no mirrored print seen through clear plastic
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  printed.name = 'label'; printed.renderOrder = 2; group.add(printed);
  group.userData.notes = [];
  group.userData.zone = z;
  return group;
}
