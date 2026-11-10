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
    return { body: V([[0, 0.0035], [0.40 * R, 0.0015], [0.66 * R, 0], [0.80 * R, 0], [0.88 * R, 0.0025], [0.95 * R, 0.0065], [R, 0.0125],
      [R, H - 0.027], [0.985 * R, H - 0.021], [0.95 * R, H - 0.016], [0.905 * R, H - 0.0105], [0.89 * R, H - 0.0075],
      [0.915 * R, H - 0.0045], [0.9 * R, H - 0.0005], [0.86 * R, H], [0.80 * R, H - 0.0025], [0.74 * R, H - 0.0045], [0, H - 0.0045]]), cap: null };
  }
  if (c.kind === 'pet') {
    return {
      body: V([[0, 0.004], [0.55 * R, 0.0015], [0.8 * R, 0], [0.92 * R, 0.004], [R, 0.014], [R, 0.58 * H], [0.985 * R, 0.62 * H],
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
