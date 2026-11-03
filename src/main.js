import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { makeStudioScene, envFromScene } from './studio.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
import { KMZLoader } from 'three/examples/jsm/loaders/KMZLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { XYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js';
import { MODEL_EXT, extOf, classify, sniffExt, buildImageSheets, buildPdfSheets } from './anyfile.js';
import { zipSync, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

const $ = (id) => document.getElementById(id);
const baseOf = (u) => decodeURIComponent(u.split(/[\\/]/).pop().split('?')[0]).toLowerCase();

// ---------- scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const envs = {
  bright: envFromScene(renderer, makeStudioScene({ bright: true })),
  studio: envFromScene(renderer, makeStudioScene()),
  room: envFromScene(renderer, new RoomEnvironment()),
};
scene.environment = envs.bright;
scene.environmentIntensity = 1.0;
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(3, 2, 4);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(5, 10, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.radius = 6; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
// ground: soft shadow catcher in normal mode, real matte floor in path-traced mode
const floorShadow = new THREE.ShadowMaterial({ opacity: 0.38 });
const floorPT = new THREE.MeshStandardMaterial({ color: 0x5f626a, roughness: 0.85, metalness: 0 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorShadow);
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.visible = false;
scene.add(floor);
const grid = new THREE.GridHelper(10, 20, 0x6a6f7a, 0x3a3e47);
grid.material.transparent = true; grid.material.opacity = 0.6;
const axes = new THREE.AxesHelper(1); axes.visible = false;
scene.add(grid, axes);

const pivot = new THREE.Group();          // handles Z-up fix
scene.add(pivot);
let current = null;                       // loaded root object
let mixer = null, actions = [], paused = false;
const clock = new THREE.Clock();
let fitSize = 1;

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- optional path tracing (photo-like, progressive) ----------
let pt = null, ptOn = false;
function ptStatus(t) { $('ptStatus').textContent = t; }
async function enablePT() {
  ptStatus('Loading path tracer…');
  try {
    if (!pt) {
      const { WebGLPathTracer } = await import('three-gpu-pathtracer');
      pt = new WebGLPathTracer(renderer);
      pt.bounces = 8; pt.transmissiveBounces = 8; pt.filterGlossyFactor = 0.5;
      pt.dynamicLowRes = true; pt.minSamples = 2;
      pt.tiles.set(3, 3);          // render each frame in 3x3 tiles so the page stays responsive on modest GPUs
    }
    if (!$('optPT').checked) { ptStatus(''); return; }      // switched off again while loading
    ptOn = true; applyPTScene();
  } catch (e) {
    console.error(e); ptOn = false; $('optPT').checked = false; ptStatus('');
    showError('Path tracing is not available on this device/browser.\n' + (e?.message || e));
  }
}
function setNested(on) {
  current?.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) if (m.userData.nested !== undefined) { m.transmission = on ? m.userData.nested : 0; m.needsUpdate = true; }
  });
  applyTint();
}
function applyPTScene() {
  if (!ptOn || !pt) return;
  setNested(true);
  grid.visible = false; axes.visible = false;
  floor.material = floorPT; floor.visible = !!current; sun.castShadow = false;
  scene.updateMatrixWorld(true);
  pt.setScene(scene, camera);
  pt.updateEnvironment();
}
function disablePT() {
  ptOn = false; ptStatus(''); setNested(false);
  floor.material = floorShadow; sun.castShadow = $('optShadow').checked; floor.visible = !!current && $('optShadow').checked;
  grid.visible = $('optGrid').checked; axes.visible = $('optAxes').checked;
  renderer.setRenderTarget(null);
}
controls.addEventListener('change', () => { if (ptOn) pt.updateCamera(); });

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (mixer && !paused) mixer.update(dt);
  controls.update();
  if (ptOn && pt) { pt.renderSample(); ptStatus(`Path tracing · ${Math.floor(pt.samples)} samples`); }
  else renderer.render(scene, camera);
});

// ---------- loading ----------
let resources = new Map();   // lower-case basename -> blob URL
let blobUrls = [];

function makeManager() {
  const m = new THREE.LoadingManager();
  m.setURLModifier((url) => {
    if (url.startsWith('data:') ) return url;
    if (url.startsWith('blob:') && [...resources.values()].includes(url)) return url;
    return resources.get(baseOf(url)) ?? url;
  });
  return m;
}

function loadWith(loader, url) {
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

const relPath = (f) => (f.relPath || f.webkitRelativePath || f.name).replace(/^\/+/, '');
const isUsdLayer = (x) => ['usd', 'usda', 'usdc'].includes(typeof x === 'string' ? extOf(x) : (x.kext || extOf(x.name)));

// Expand .zip uploads (USD projects, glTF folders...) into virtual files. .usdz is left alone.
function expandZips(files) {
  const out = [];
  for (const f of files) {
    if (extOf(f.name) !== 'zip') { out.push(f); continue; }
    return f.arrayBuffer().then((buf) => {
      const entries = unzipSync(new Uint8Array(buf));
      const list = Object.entries(entries)
        .filter(([n, b]) => !n.endsWith('/') && b.length && !n.includes('__MACOSX') && !n.split('/').pop().startsWith('._'))
        .map(([n, b]) => { const vf = new File([b], n.split('/').pop()); vf.relPath = n; return vf; });
      return expandZips([...list, ...files.filter((x) => x !== f)]);
    });
  }
  return out;
}

// Choose the root layer of a multi-file USD project: the layer nothing else references.
async function pickUsdRoot(layers) {
  if (layers.length === 1) return layers[0];
  const refd = new Set();
  const dec = new TextDecoder();
  for (const f of layers) {
    const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
    if (String.fromCharCode(...head) === 'PXR-USDC') continue;          // binary: cannot scan cheaply
    const txt = dec.decode(await f.arrayBuffer());
    for (const m of txt.matchAll(/@([^@\n]+)@/g)) refd.add(baseOf(m[1]));
  }
  const depth = (f) => relPath(f).split('/').length;
  const score = (f) => (refd.has(f.name.toLowerCase()) ? 1000 : 0) + depth(f) * 10 - (/preview|scene|root|main|stage/i.test(f.name) ? 5 : 0);
  return [...layers].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))[0];
}

// ---- optional server: real OpenUSD converts the project to GLB (handles payloads, variants, big files)
let apiOk = null;
async function serverAvailable() {
  if (apiOk !== null) return apiOk;
  try { const r = await fetch('api/health', { cache: 'no-store' }); apiOk = r.ok && (await r.json()).ok === true; }
  catch { apiOk = false; }
  return apiOk;
}
async function convertOnServer(files, variants = {}, project = '', signal) {
  const fd = new FormData();
  if (Object.keys(variants).length) fd.append('variants', JSON.stringify(variants));
  if (project) fd.append('project', project);               // files already on the server: no re-upload
  for (const f of project ? [] : files) {
    if (!/\.(usd|usda|usdc|usdz|png|jpe?g|webp|bmp|tga|exr)$/i.test(f.name)) continue;
    fd.append('files', f, relPath(f)); fd.append('paths', relPath(f));
  }
  const r = await fetch('api/convert', { method: 'POST', body: fd, signal });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* not json */ }
    const err = new Error(msg); err.status = r.status; throw err;
  }
  return { blob: await r.blob(), info: JSON.parse(r.headers.get('X-Convert-Info') || '{}') };
}

// Feed the whole project to USDLoader as a virtual USDZ so references/sublayers/textures resolve.
async function loadUsdProject(root, files, manager) {
  const entries = {};
  entries[relPath(root)] = [new Uint8Array(await root.arrayBuffer()), { level: 0 }];   // root must be first
  for (const f of files) {
    if (f === root || !/\.(usd|usda|usdc|png|jpe?g|avif)$/i.test(f.name)) continue;
    entries[relPath(f)] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
  }
  const zip = zipSync(entries);
  return new Promise((res, rej) => new USDLoader(manager).parse(zip.buffer, '', res, rej));
}

// point clouds: size the points relative to the cloud so they stay visible at any scale
function pointsFrom(geo) {
  geo.computeBoundingBox();
  const diag = geo.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const hasColor = !!geo.attributes.color;
  return new THREE.Points(geo, new THREE.PointsMaterial({ size: diag / 350, vertexColors: hasColor, color: hasColor ? 0xffffff : 0xb8c0cc }));
}

async function parseModel(file, url, manager, files = [file]) {
  const ext = file.kext || extOf(file.name);
  switch (ext) {
    case 'usdz':
      return loadWith(new USDLoader(manager), url);
    case 'usd': case 'usda': case 'usdc':
      if (files.filter((f) => isUsdLayer(f)).length > 1 || files.some((f) => relPath(f).includes('/')))
        return loadUsdProject(file, files, manager);
      return loadWith(new USDLoader(manager), url);
    case 'glb': case 'gltf': {
      const l = new GLTFLoader(manager);
      l.setDRACOLoader(new DRACOLoader().setDecoderPath('./draco/'));
      l.setMeshoptDecoder(MeshoptDecoder);
      const g = await loadWith(l, url);
      const root = g.scene;
      root.userData.animations = g.animations;
      return root;
    }
    case 'dae': {
      const c = await loadWith(new ColladaLoader(manager), url);
      const root = c.scene;
      root.userData.animations = c.animations || [];
      return root;
    }
    case 'obj': {
      const l = new OBJLoader(manager);
      const mtl = [...resources.keys()].find((k) => k.endsWith('.mtl'));
      if (mtl) {
        const mats = await loadWith(new MTLLoader(manager), resources.get(mtl));
        mats.preload(); l.setMaterials(mats);
      }
      return loadWith(l, url);
    }
    case 'fbx': return loadWith(new FBXLoader(manager), url);
    case 'wrl': return loadWith(new VRMLLoader(manager), url);
    case '3mf': return loadWith(new ThreeMFLoader(manager), url);
    case '3ds': return loadWith(new TDSLoader(manager), url);
    case 'amf': return loadWith(new AMFLoader(manager), url);
    case 'kmz': return (await loadWith(new KMZLoader(manager), url)).scene;
    case 'pcd': return loadWith(new PCDLoader(manager), url);
    case 'xyz': return pointsFrom(await loadWith(new XYZLoader(manager), url));
    case 'stl': case 'ply': {
      const geo = await loadWith(ext === 'stl' ? new STLLoader(manager) : new PLYLoader(manager), url);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const hasColor = !!geo.attributes.color;
      if (!geo.index && !geo.attributes.normal && ext === 'ply') return pointsFrom(geo);   // point cloud
      return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8c0cc, vertexColors: hasColor, roughness: 0.6, metalness: 0.1 }));
    }
    default: throw new Error(`Unsupported format: .${ext}`);
  }
}

function disposeCurrent() {
  if (!current) return;
  pivot.remove(current);
  current.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
  current = null; mixer = null; actions = [];
  $('animBox').hidden = true;
}

async function openFiles(fileList) {
  // copy NOW: a file input's FileList is live and is emptied by the caller right after this starts,
  // so anything iterated after an `await` would silently lose files
  const dropped = [...fileList];
  setLoading(true); showError(null);
  // a zip with a missing/odd extension is still a zip: recognise it by content
  let incoming = [];
  for (const f of dropped) {
    const e = extOf(f.name);
    const known = MODEL_EXT.includes(e) || e === 'zip' || ['pdf', 'exr', 'hdr', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(e);
    incoming.push(!known && (await sniffExt(f)) === 'zip' ? new File([f], f.name + '.zip') : f);
  }
  let files;
  try { files = await expandZips(incoming); } catch (e) { setLoading(false); return showError('Could not read the zip file.\n' + (e?.message || e)); }
  // recognise every file by name, or by content when the name does not say
  const kinds = await Promise.all(files.map(classify));
  files.forEach((f, i) => { f.kind = kinds[i].kind; f.kext = kinds[i].ext; });
  const usd = files.filter((f) => isUsdLayer(f));
  const usdz = files.find((f) => f.kext === 'usdz');
  const model = usdz ?? (usd.length ? await pickUsdRoot(usd) : files.find((f) => f.kind === '3d'));
  if (model) { session = { files, model, variants: {}, mode: '3d' }; return loadSession(false); }
  const pdf = files.find((f) => f.kind === 'pdf');
  if (pdf) { session = { files, model: pdf, variants: {}, mode: 'pdf' }; return loadSession(false); }
  const imgs = files.filter((f) => f.kind === 'image' || f.kind === 'hdr');
  if (imgs.length) { session = { files, model: imgs[0], images: imgs, variants: {}, mode: 'images' }; return loadSession(false); }
  setLoading(false);
  const f = dropped[0] ?? files[0];
  const kb = f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB';
  showError(`Can't preview "${f.name}" (${kb}).\nIt isn't a 3D model, image or PDF that I can recognise, even by its contents.\n` +
    'Documents such as Word or Excel have no 3D form; export them to PDF to view them here.');
}

let loadAbort = null;
let session = null;        // the files currently shown, so a configuration change can re-convert them
let sessionToken = 0;

async function loadSession(keepView) {
  const { files, model, variants } = session;
  const token = ++sessionToken;
  loadAbort?.abort(); loadAbort = new AbortController();     // a newer load cancels the one still waiting on the server
  setLoading(true); showError(null);
  const savedView = keepView ? { p: camera.position.clone(), t: controls.target.clone(), fov: camera.fov, near: camera.near, far: camera.far } : null;
  blobUrls.forEach(URL.revokeObjectURL); blobUrls = [];
  resources = new Map();
  for (const f of files) {
    const u = URL.createObjectURL(f); blobUrls.push(u);
    resources.set(f.name.toLowerCase(), u);
  }
  try {
    let root, notes = [], meshInfo = [], srvInfo = null;
    if (session.mode === 'pdf') root = await buildPdfSheets(model);
    else if (session.mode === 'images') root = await buildImageSheets(session.images.map((f) => ({ file: f, kind: f.kind, ext: f.kext })));
    else if (isUsdLayer(model) || (model.kext || extOf(model.name)) === 'usdz') {
      if (await serverAvailable()) {
        let res;
        try { res = await convertOnServer(files, variants, keepView ? session.project : '', loadAbort.signal); }
        catch (e) { if (e.status === 410) res = await convertOnServer(files, variants, '', loadAbort.signal); else throw e; }   // expired: re-send
        const { blob, info } = res;                                           // real OpenUSD
        session.project = info.project || '';
        const url = URL.createObjectURL(blob); blobUrls.push(url);
        root = await parseModel({ name: 'converted.glb' }, url, makeManager());
        notes = [`Converted with OpenUSD (converter ${info.version || 'old'})`, ...(info.warnings || [])];
        meshInfo = info.meshes || []; srvInfo = info;
      }
    }
    if (!root) root = await parseModel(model, resources.get(model.name.toLowerCase()), makeManager(), files);
    if (token !== sessionToken) return;                       // a newer load started meanwhile
    if (root.userData.notes?.length) notes = root.userData.notes;
    root.userData.notes = notes; root.userData.meshInfo = meshInfo;
    disposeCurrent();
    current = root; pivot.add(root);
    prepare(root, model);
    if (srvInfo) await setupFromServer(srvInfo, keepView);
    if (savedView) {
      camera.position.copy(savedView.p); controls.target.copy(savedView.t);
      camera.fov = savedView.fov; camera.near = savedView.near; camera.far = savedView.far;
      camera.updateProjectionMatrix(); controls.update();
    }
    $('drop').classList.add('hidden');
    $('panel').hidden = false;
    if (ptOn) applyPTScene();
  } catch (e) {
    if (e?.name === 'AbortError') return;                    // superseded by a newer load
    console.error(e);
    showError(`Could not open "${model.name}".\n${e?.message || e || 'unknown error'}\n(Use "Copy diagnostics" and send it if this keeps happening.)`);
  } finally { if (token === sessionToken) setLoading(false); }
}

// configuration menus, Grip lighting and droplet glass, driven by what the server reports
const CONFIG_LABELS = { Dry: 'Dry', Wet: 'Wet (droplets)', Open_Dry: 'Open cap · dry', Open_Wet: 'Open cap · wet (droplets)' };
const CONFIG_ORDER = ['Dry', 'Wet', 'Open_Dry', 'Open_Wet'];
async function setupFromServer(info, keepView) {
  const vis = (info.variants || []).find((v) => v.set === 'Visibility');
  const art = (info.variants || []).find((v) => v.set === 'Artwork');
  $('variantBox').hidden = !(vis || art);
  if (vis) {
    const opts = [...vis.options].sort((x, y) => (CONFIG_ORDER.indexOf(x) + 99) % 99 - (CONFIG_ORDER.indexOf(y) + 99) % 99);
    $('optConfig').innerHTML = opts.map((o) => `<option value="${o}">${CONFIG_LABELS[o] || o}</option>`).join('');
    $('optConfig').value = vis.selected;
  }
  $('optConfig').parentElement.hidden = !vis;
  $('artVarLabel').hidden = !art;
  if (art) {
    $('optArtVar').innerHTML = art.options.map((o) => `<option value="${o}">${o[0].toUpperCase() + o.slice(1)}</option>`).join('');
    $('optArtVar').value = art.selected;
  }
  $('tintLabel').hidden = !(info.meshes || []).some((m) => m.glass);
  applyTint();
  if ((info.meshes || []).some((m) => m.glass) && !keepView) {      // clear liquid/glass reads best on a light backdrop
    $('optBg').value = '#ffffff'; scene.background = new THREE.Color('#ffffff'); if (ptOn) pt.updateEnvironment();
  }
  if (info.env && !keepView) {
    try {
      const r = await fetch(`api/env/${info.env.id}`);
      if (r.ok) {
        const data = new Uint16Array(await r.arrayBuffer());
        const t = new THREE.DataTexture(data, info.env.w, info.env.h, THREE.RGBAFormat, THREE.HalfFloatType,
          THREE.EquirectangularReflectionMapping, THREE.RepeatWrapping, THREE.ClampToEdgeWrapping,
          THREE.LinearFilter, THREE.LinearFilter);
        t.needsUpdate = true; envs.grip = t;
        if (!$('optEnv').querySelector('option[value=grip]')) {
          const op = document.createElement('option'); op.value = 'grip'; op.textContent = 'Grip studio (from file)';
          $('optEnv').prepend(op);
        }
        $('optEnv').value = 'grip'; applyEnv(); if (ptOn) pt.updateEnvironment();
      }
    } catch (e) { console.warn('environment not loaded', e); }
  }
}

function prepare(root, file) {
  // Give meshes without materials/normals something sensible to render.
  let tris = 0, meshes = 0; const mats = new Set();
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      meshes++; o.castShadow = true;
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const idx = o.geometry.index;
      tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
      for (const m of [].concat(o.material)) { mats.add(m); m.userData._side = m.side; }
      if (!o.material) o.material = new THREE.MeshStandardMaterial({ color: 0xb8c0cc });
    }
  });
  applyWire(); applyDouble();
  buildLayers(root);
  root.updateMatrixWorld(true);
  const trans = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) if (m.transmission > 0) {
      m.roughness = Math.min(m.roughness ?? 0.05, 0.05);
      trans.push({ m, name: o.name || '', box: new THREE.Box3().setFromObject(o) });
    }
  });
  // The normal renderer cannot see one transparent object through another (e.g. liquid inside a glass bottle),
  // so an inner transmissive object is shown as a tinted solid. The path tracer restores true transmission.
  const vol = (bx) => { const sz = bx.getSize(new THREE.Vector3()); return Math.max(sz.x * sz.y * sz.z, 1e-18); };
  const looksLikeLiquid = (n) => /liquid|cola|drink|juice|beer|wine|milk|water|fluid|soda/i.test(n);
  for (const a of trans) {
    if (a.m.userData.nested !== undefined) continue;
    // inner = mostly inside another transmissive object (by volume overlap), or named like a liquid next to one
    const inner = trans.some((b) => b !== a && vol(b.box) > vol(a.box) * 1.02 &&
        vol(a.box.clone().intersect(b.box)) / vol(a.box) > 0.7) || (looksLikeLiquid(a.name) && trans.length > 1);
    if (inner) {
      a.m.userData.nested = a.m.transmission;
      if (!ptOn) { a.m.transmission = 0; a.m.needsUpdate = true; }
    }
  }
  if (root.userData.meshInfo?.length) console.table(root.userData.meshInfo);
  const anims = root.userData.animations || [];
  if (anims.length) {
    mixer = new THREE.AnimationMixer(root);
    actions = anims.map((c) => mixer.clipAction(c));
    $('animSel').innerHTML = anims.map((c, i) => `<option value="${i}">${c.name || 'Clip ' + (i + 1)}</option>`).join('');
    playAnim(0); $('animBox').hidden = false;
  }
  syncUI();
  fitView();
  if (!meshes && !root.getObjectByProperty('isPoints', true)) {
    showError(`"${file.name}" loaded but contains no geometry.\nIf it references other files (e.g. @./asset.usda@), drop the whole folder or a .zip of the project together.`);
  }
  const s = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
  const rows = [
    ['File', file.name], ['Size', (file.size / 1048576).toFixed(2) + ' MB'],
    ['Meshes', meshes.toLocaleString()], ['Triangles', Math.round(tris).toLocaleString()],
    ['Materials', mats.size], ['Dimensions', [s.x, s.y, s.z].map((v) => +v.toPrecision(3)).join(' × ')],
  ];
  const notes = root.userData.notes || [];
  if (notes.length) rows.push(['Notes', notes.join(' · ')]);
  $('info').innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}

function buildLayers(root) {
  const box = $('layerBox'), list = $('layers');
  list.innerHTML = '';
  const meshes = [];
  root.traverse((o) => { if (o.isMesh || o.isPoints) meshes.push(o); });
  const isArt = (o) => /artwork/i.test(o.name || o.parent?.name || '');
  const hasArt = meshes.some(isArt);
  $('artLabel').hidden = !hasArt;
  if (hasArt) meshes.filter(isArt).forEach((o) => { o.visible = $('optArtwork').checked; });
  box.hidden = meshes.length < 2 || meshes.length > 60;
  meshes.forEach((o, i) => {
    const id = 'layer' + i;
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = id; cb.checked = o.visible;
    cb.onchange = () => { o.visible = cb.checked; if (ptOn) applyPTScene(); };
    const nm = o.name || o.parent?.name || 'mesh ' + (i + 1);
    const mi = (root.userData.meshInfo || []).find((m) => m.mesh === nm);
    if (mi) {
      const uv = mi.uv ? ` · UV ${mi.uv.varname || 'default'}${mi.uv.scale ? ' scale ' + mi.uv.scale.map((v) => +v.toFixed(3)).join('×') : ''}` : '';
      lab.title = `material ${mi.material}${mi.glass ? ' · glass/liquid' : ''}${mi.tint ? ' · tint rgb(' + mi.tint.join(',') + ')' : ''} · texture ${mi.texture ? 'yes' : 'no'}${mi.atlas ? ' · artwork atlas decoded' : ''}${mi.alpha ? ' · transparent' : ''}${uv}`;
    }
    lab.append(cb, ' ', nm);
    list.append(lab);
  });
}

function fitView() {
  const box = new THREE.Box3().setFromObject(pivot);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.length() / 2, 1e-6);
  fitSize = r;
  const d = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.near = d / 1000; camera.far = d * 100; camera.updateProjectionMatrix();
  camera.position.copy(c).add(new THREE.Vector3(0.6, 0.45, 0.8).normalize().multiplyScalar(d));
  controls.target.copy(c); controls.update();
  grid.scale.setScalar((r * 4) / 10);   // 10-unit helper -> ~4x model radius
  grid.position.y = box.min.y;
  axes.scale.setScalar(r); axes.position.set(box.min.x, box.min.y, box.min.z);
  sun.position.copy(c).add(new THREE.Vector3(r * 2, r * 4, r * 3));
  sun.target.position.copy(c); sun.target.updateMatrixWorld();
  const sc = sun.shadow.camera;
  sc.left = -r * 2; sc.right = r * 2; sc.top = r * 2; sc.bottom = -r * 2; sc.near = r * 0.1; sc.far = r * 12;
  sc.updateProjectionMatrix();
  floor.scale.setScalar(r * 12); floor.position.set(c.x, box.min.y - r * 0.001, c.z);
  floor.visible = ptOn || $('optShadow').checked;
  if (ptOn) applyPTScene();
}

// ---------- UI ----------
function syncUI() {      // apply the checkbox states as shown (the browser/host may restore them)
  grid.visible = $('optGrid').checked; axes.visible = $('optAxes').checked;
  controls.autoRotate = $('optRotate').checked; controls.autoRotateSpeed = 2;
  pivot.rotation.x = $('optZup').checked ? -Math.PI / 2 : 0; pivot.updateMatrixWorld(true);
  scene.background = new THREE.Color($('optBg').value);
  applyLight(); applyEnv();
  sun.castShadow = $('optShadow').checked && !ptOn; floor.visible = !!current && (ptOn || $('optShadow').checked);
  applyWire(); applyDouble();
}
function applyTint() {
  // Glass/liquid absorb light in proportion to thickness: transmittance = tint ** k. The slider scales k.
  const mult = +$('optTint').value;
  const byName = {};
  (current?.userData.meshInfo || []).forEach((mi) => { byName[mi.mesh] = mi; });
  current?.traverse((o) => {
    if (!o.isMesh) return;
    const mi = byName[o.name];
    if (!mi?.glass || !(mi.k > 0) || !mi.tint_lin) return;
    const k = mi.k * mult;
    for (const m of [].concat(o.material)) {
      if (m.userData.nested !== undefined) {          // inner liquid: tinted solid in the normal view, true volume in path tracing
        if (ptOn) m.color.setRGB(1, 1, 1);
        else {
          let rgb = mi.tint_lin.map((c) => Math.pow(Math.max(c, 1e-4), k));
          const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
          if (lum < 0.06) rgb = rgb.map((c) => Math.min(1, (c * 0.06) / Math.max(lum, 1e-6)));   // never pitch black: keep the hue
          m.color.setRGB(...rgb);
        }
      } else m.thickness = k;
    }
  });
  if (ptOn && pt) pt.updateMaterials();
}
function applyLight() { const v = +$('optLight').value; sun.intensity = 0.8 * v; scene.environmentIntensity = v; renderer.toneMappingExposure = +$('optExposure').value; }
function applyEnv() {
  scene.environment = envs[$('optEnv').value] ?? envs.bright;
  const r = THREE.MathUtils.degToRad(+$('optEnvRot').value);
  scene.environmentRotation.set(0, r, 0); scene.backgroundRotation.set(0, r, 0);
}
let loadTimer = null;
function setLoading(v) {
  const el = $('loading'); el.hidden = !v;
  clearInterval(loadTimer);
  if (v) {
    const t0 = Date.now();
    const tick = () => { el.textContent = `Loading… ${Math.round((Date.now() - t0) / 1000)} s (large projects can take a minute)`; };
    tick(); loadTimer = setInterval(tick, 1000);
  }
}
function showError(msg) { const e = $('error'); e.hidden = !msg; e.textContent = msg || ''; }
function eachMat(fn) { current?.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach(fn); }); }
function applyWire() { const w = $('optWire').checked; eachMat((m) => (m.wireframe = w)); }
function applyDouble() { const d = $('optDouble').checked; eachMat((m) => { m.side = d ? THREE.DoubleSide : (m.userData._side ?? THREE.FrontSide); m.needsUpdate = true; }); }
function playAnim(i) { actions.forEach((a) => a.stop()); actions[i]?.reset().play(); }

$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { if (e.target.files.length) openFiles(e.target.files); e.target.value = ''; };
$('folderBtn').onclick = () => $('folderInput').click();
$('folderInput').onchange = (e) => { if (e.target.files.length) openFiles(e.target.files); e.target.value = ''; };
$('sampleBtn').onclick = async () => {
  const r = await fetch('./sample.usda');
  openFiles([new File([await r.blob()], 'sample.usda')]);
};
$('optGrid').onchange = (e) => (grid.visible = e.target.checked);
$('optAxes').onchange = (e) => (axes.visible = e.target.checked);
$('optWire').onchange = () => { applyWire(); if (ptOn) applyPTScene(); };
$('optDouble').onchange = () => { applyDouble(); if (ptOn) applyPTScene(); };
$('optRotate').onchange = (e) => { controls.autoRotate = e.target.checked; controls.autoRotateSpeed = 2; };
$('optZup').onchange = (e) => { pivot.rotation.x = e.target.checked ? -Math.PI / 2 : 0; pivot.updateMatrixWorld(true); fitView(); };
$('optBg').onchange = (e) => { scene.background = new THREE.Color(e.target.value); if (ptOn) pt.updateEnvironment(); };
$('optLight').oninput = () => { applyLight(); if (ptOn) { pt.updateLights(); pt.updateEnvironment(); } };
$('optExposure').oninput = () => { applyLight(); if (ptOn) pt.reset(); };
$('optEnv').onchange = () => { applyEnv(); if (ptOn) pt.updateEnvironment(); };
$('optTint').oninput = applyTint;
$('optEnvRot').oninput = () => { applyEnv(); if (ptOn) pt.updateEnvironment(); };
function changeVariant(set, value) {
  if (!session) return;
  session.variants = { ...session.variants, [set]: value };
  loadSession(true);                      // re-convert with the new selection, keep the camera
}
$('optConfig').onchange = (e) => changeVariant('Visibility', e.target.value);
$('optArtVar').onchange = (e) => changeVariant('Artwork', e.target.value);
$('optArtwork').onchange = () => { if (current) { buildLayers(current); if (ptOn) applyPTScene(); } };
$('optShadow').onchange = (e) => { sun.castShadow = e.target.checked && !ptOn; floor.visible = !!current && (ptOn || e.target.checked); };
$('optPT').onchange = (e) => { if (e.target.checked) enablePT(); else disablePT(); };
$('fitBtn').onclick = fitView;
$('animSel').onchange = (e) => playAnim(+e.target.value);
$('animPlay').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Play' : 'Pause'; };
$('shotBtn').onclick = () => {
  if (!ptOn) renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png'); a.download = 'screenshot.png'; a.click();
};
scene.background = new THREE.Color($('optBg').value);

// drag & drop (whole window)
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = await collectDropped(e.dataTransfer);
  if (files.length) openFiles(files);
});

// supports dropping folders as well as multiple files
async function collectDropped(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (en) => {
    if (en.isFile) { const f = await new Promise((r, j) => en.file(r, j)); f.relPath = en.fullPath; out.push(f); }
    else if (en.isDirectory) {
      const rd = en.createReader();
      let batch;
      do { batch = await new Promise((r, j) => rd.readEntries(r, j)); for (const c of batch) await walk(c); } while (batch.length);
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

// expose for testing
window.__viewer = { openFiles, scene, camera };

// ---------- diagnostics: one click copies everything needed to debug a model that looks wrong
$('diagBtn').onclick = async () => {
  const lines = [
    `viewer: ${location.href}`, `file: ${session?.model?.name || '-'}  mode: ${session?.mode || '-'}`,
    `notes: ${(current?.userData.notes || []).join(' | ')}`,
    `variants: ${JSON.stringify(session?.variants || {})}`, `meshes:`,
    ...(current?.userData.meshInfo || []).map((m) => '  ' + JSON.stringify(m)),
  ];
  current?.traverse((o) => {
    if (o.isMesh) for (const m of [].concat(o.material)) {
      lines.push(`  three ${o.name}: ${m.type} transmission=${m.transmission ?? '-'} nested=${m.userData.nested ?? '-'} thickness=${m.thickness ?? '-'} color=${m.color?.getHexString?.()}`);
    }
  });
  const text = lines.join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  $('diagBtn').textContent = 'Copied!'; setTimeout(() => { $('diagBtn').textContent = 'Copy diagnostics'; }, 1800);
};
