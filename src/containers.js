// Default containers (cans, PET bottles, a glass contour bottle) as lathe profiles, plus helpers for labels.
import * as THREE from 'three';

const V = (pts) => pts.map(([r, y]) => new THREE.Vector2(r, y));

export const CONTAINERS = {
  can330:   { label: 'Can 330 ml (standard)',        kind: 'can',   D: 0.066,  H: 0.115 },
  can330s:  { label: 'Can 330 ml (sleek)',           kind: 'can',   D: 0.0585, H: 0.146 },
  can200:   { label: 'Can 200 ml (slim)',            kind: 'can',   D: 0.0523, H: 0.113 },
  pet500:   { label: 'PET bottle 500 ml',            kind: 'pet',   D: 0.065,  H: 0.205, center: 0.40 },
  pet1l:    { label: 'PET bottle 1 L',               kind: 'pet',   D: 0.085,  H: 0.300, center: 0.40 },
  pet15l:   { label: 'PET bottle 1.5 L',             kind: 'pet',   D: 0.092,  H: 0.330, center: 0.40 },
  pet25l:   { label: 'PET bottle 2.5 L',             kind: 'pet',   D: 0.108,  H: 0.345, center: 0.40 },
  glass330: { label: 'Glass contour bottle 330 ml',  kind: 'glass', D: 0.063,  H: 0.205, center: 0.42 },
};

/** Profile points {body, cap} as (radius, height) for a container. */
export function containerParts(id, R, H) {
  const c = CONTAINERS[id];
  if (c.kind === 'can') {
    const t = H - 0.0095;                                                         // lid panel height: recessed below the rim, like a real can
    return { body: V([[0, 0.0105], [0.30 * R, 0.009], [0.50 * R, 0.0048], [0.60 * R, 0.0012], [0.66 * R, 0], [0.72 * R, 0], [0.80 * R, 0.0012],
      [0.90 * R, 0.0048], [0.97 * R, 0.0098], [R, 0.0165],
      [R, H - 0.0205], [0.985 * R, H - 0.0168], [0.94 * R, H - 0.0122], [0.885 * R, H - 0.0086], [0.835 * R, H - 0.0062], [0.805 * R, H - 0.0045],   // shoulder tapering to the neck
      [0.80 * R, H - 0.0022], [0.808 * R, H - 0.0006], [0.82 * R, H], [0.795 * R, H + 0.0003], [0.77 * R, H - 0.0004], [0.757 * R, H - 0.0025],      // the rolled seam
      [0.75 * R, H - 0.0058], [0.742 * R, t + 0.0012], [0.715 * R, t], [0.66 * R, t - 0.0003], [0, t - 0.0003]]), cap: null };
  }
  if (c.kind === 'pet') {
    return {
      body: V([[0, 0.030 * H], [0.30 * R, 0.026 * H], [0.55 * R, 0.012 * H], [0.72 * R, 0.002 * H], [0.86 * R, 0.003 * H], [0.95 * R, 0.014 * H], [R, 0.045 * H], [R, 0.58 * H], [0.985 * R, 0.62 * H],
        [0.93 * R, 0.66 * H], [0.80 * R, 0.705 * H], [0.60 * R, 0.76 * H], [0.45 * R, 0.82 * H], [0.43 * R, 0.855 * H], [0.43 * R, 0.895 * H]]),
      cap: V([[0.43 * R, 0.895 * H], [0.52 * R, 0.9 * H], [0.52 * R, 0.91 * H], [0.46 * R, 0.917 * H], [0.5 * R, 0.925 * H],
        [0.5 * R, 0.985 * H], [0.45 * R, H], [0, H]]),
    };
  }
  // glass contour bottle
  return {
    body: V([[0, 0.003], [0.6 * R, 0], [0.85 * R, 0.002], [0.95 * R, 0.01], [R, 0.03 * H], [0.98 * R, 0.12 * H], [0.92 * R, 0.22 * H],
      [0.84 * R, 0.30 * H], [0.80 * R, 0.38 * H], [0.84 * R, 0.46 * H], [0.93 * R, 0.54 * H], [0.99 * R, 0.62 * H], [R, 0.66 * H],
      [0.9 * R, 0.72 * H], [0.62 * R, 0.78 * H], [0.40 * R, 0.84 * H], [0.30 * R, 0.88 * H], [0.28 * R, 0.93 * H]]),
    cap: V([[0.28 * R, 0.93 * H], [0.36 * R, 0.935 * H], [0.38 * R, 0.945 * H], [0.36 * R, 0.975 * H], [0.30 * R, H], [0, H]]),
  };
}

/** Push the base of a lathe into five feet (petaloid) so a PET bottle stands on them like the real thing. */
export function petaloid(geo, R, H) {
  const pos = geo.attributes.position, lim = 0.075 * H;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), r = Math.hypot(x, z);
    if (y >= lim || r < 0.2 * R) continue;
    const k = Math.pow(1 - y / lim, 1.5), th = Math.atan2(x, z), valley = (1 - Math.cos(5 * th)) / 2;
    const f = 1 - 0.10 * k * valley;
    pos.setXYZ(i, x * f, y + 0.020 * H * k * valley, z * f);
  }
  geo.computeVertexNormals(); return geo;
}

/** Shared body materials: brushed-looking aluminium, clear PET, clear green-tinged glass. */
export function bodyMaterial(kind) {
  if (kind === 'can') return new THREE.MeshPhysicalMaterial({ color: 0xc6cad0, metalness: 1, roughness: 0.2, anisotropy: 0.4, side: THREE.DoubleSide, envMapIntensity: 1.25 });
  // clear plastic / glass: mostly see-through with bright edge reflections (a dark backdrop would turn real transmission into "cola")
  const m = new THREE.MeshPhysicalMaterial({ color: kind === 'pet' ? 0xf4fafc : 0xe4f6ea, roughness: 0.04, transparent: true, opacity: kind === 'pet' ? 0.3 : 0.34,
    clearcoat: 1, clearcoatRoughness: 0.03, ior: kind === 'pet' ? 1.45 : 1.52, specularIntensity: 1, envMapIntensity: 2.4, side: THREE.DoubleSide, depthWrite: false });
  return m;
}

/** Stay-on tab and rivet for a can lid (flat meshes sitting on the lid panel). */
export function canTab(R, H) {
  const lid = 0.75 * R, len = lid * 1.05, w = lid * 0.55, y = H - 0.0095 - 0.0003;
  const sh = new THREE.Shape(), r = w * 0.45, x0 = -w / 2, x1 = w / 2, z0 = -len * 0.5, z1 = len * 0.5;
  sh.moveTo(x0 + r, z0); sh.lineTo(x1 - r, z0); sh.quadraticCurveTo(x1, z0, x1, z0 + r); sh.lineTo(x1, z1 - r);
  sh.quadraticCurveTo(x1, z1, x1 - r, z1); sh.lineTo(x0 + r, z1); sh.quadraticCurveTo(x0, z1, x0, z1 - r); sh.lineTo(x0, z0 + r); sh.quadraticCurveTo(x0, z0, x0 + r, z0);
  const hole = new THREE.Path(); hole.absellipse(0, len * 0.22, w * 0.30, len * 0.20, 0, Math.PI * 2, true); sh.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.0006, bevelEnabled: false, curveSegments: 20 });
  g.rotateX(-Math.PI / 2); g.translate(0, y + 0.0006, -len * 0.08);
  const rivet = new THREE.CylinderGeometry(w * 0.16, w * 0.19, 0.0012, 24); rivet.translate(0, y + 0.0012, 0);
  return { tab: g, rivet };
}

/** One closed profile (body + cap) for a single lathe. */
export function containerProfile(id, R, H) {
  const { body, cap } = containerParts(id, R, H);
  return cap ? [...body, ...cap.slice(1)] : body;
}

/** Outer radius of a profile at height y (linear interpolation along the rising part of the profile). */
export function radiusAt(points, y) {
  let best = points[0].x, bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
    if (y >= lo && y <= hi && hi > lo) { const t = (y - a.y) / (b.y - a.y); return a.x + (b.x - a.x) * t; }
    const d = Math.min(Math.abs(y - a.y), Math.abs(y - b.y));
    if (d < bestD) { bestD = d; best = Math.abs(y - a.y) < Math.abs(y - b.y) ? a.x : b.x; }
  }
  return best;
}

/** Pick a sensible default container from the label's proportions and any volume written in the file name. */
export function autoContainer(labelAspect, name = '') {
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s?(ml|cl|l)(?![a-z])/i);      // "1.0L_label" counts, "1 label" does not
  let ml = null;
  if (m) { const v = parseFloat(m[1].replace(',', '.')); ml = /^ml$/i.test(m[2]) ? v : /^cl$/i.test(m[2]) ? v * 10 : v * 1000; }
  const wide = labelAspect >= 3.0;                 // a wide, short label is a bottle sleeve; a squarer one is a printed can body
  if (/glass|vidro/i.test(name) || (/contour/i.test(name) && !/pet|bopp|rotulo|label/i.test(name))) return 'glass330';   // "NRPET Contour" is a PET label, not glass
  if (wide || (ml && ml >= 500)) return ml && ml >= 2000 ? 'pet25l' : ml && ml >= 1300 ? 'pet15l' : ml && ml >= 800 ? 'pet1l' : ml && ml > 350 ? 'pet500' : labelAspect > 4.2 ? 'pet1l' : 'pet500';
  if (ml && ml <= 230) return 'can200';
  return labelAspect < 1.9 ? 'can330s' : 'can330';
}
