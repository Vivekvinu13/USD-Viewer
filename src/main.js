import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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
import { zipSync, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

const $ = (id) => document.getElementById(id);
const MODEL_EXT = ['usd', 'usda', 'usdc', 'usdz', 'gltf', 'glb', 'dae', 'obj', 'fbx', 'stl', 'ply', '3mf', 'wrl'];
const extOf = (n) => n.split('.').pop().toLowerCase();
const baseOf = (u) => decodeURIComponent(u.split(/[\\/]/).pop().split('?')[0]).toLowerCase();

// ---------- scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(3, 2, 4);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(5, 10, 7);
scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x444455, 0.15));
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

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (mixer && !paused) mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
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
const isUsdLayer = (n) => ['usd', 'usda', 'usdc'].includes(extOf(n));

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
async function convertOnServer(files) {
  const fd = new FormData();
  for (const f of files) {
    if (!/\.(usd|usda|usdc|usdz|png|jpe?g|webp|bmp|tga)$/i.test(f.name)) continue;   // skip .exr etc.
    fd.append('files', f, relPath(f)); fd.append('paths', relPath(f));
  }
  const r = await fetch('api/convert', { method: 'POST', body: fd });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* not json */ }
    throw new Error(msg);
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

async function parseModel(file, url, manager, files = [file]) {
  const ext = extOf(file.name);
  switch (ext) {
    case 'usdz':
      return loadWith(new USDLoader(manager), url);
    case 'usd': case 'usda': case 'usdc':
      if (files.filter((f) => isUsdLayer(f.name)).length > 1 || files.some((f) => relPath(f).includes('/')))
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
    case 'stl': case 'ply': {
      const geo = await loadWith(ext === 'stl' ? new STLLoader(manager) : new PLYLoader(manager), url);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const hasColor = !!geo.attributes.color;
      if (!geo.index && !geo.attributes.normal && ext === 'ply') {   // point cloud
        return new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.01, vertexColors: hasColor }));
      }
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
  setLoading(true); showError(null);
  let files;
  try { files = await expandZips([...fileList]); } catch (e) { setLoading(false); return showError('Could not read the zip file.\n' + (e?.message || e)); }
  const usd = files.filter((f) => isUsdLayer(f.name));
  const usdz = files.find((f) => extOf(f.name) === 'usdz');
  const model = usdz ?? (usd.length ? await pickUsdRoot(usd) : files.find((f) => MODEL_EXT.includes(extOf(f.name))));
  if (!model) { setLoading(false); return showError('No supported 3D file found.\nSupported: ' + MODEL_EXT.map((e) => '.' + e).join(' ') + ' (or a .zip of them)'); }
  blobUrls.forEach(URL.revokeObjectURL); blobUrls = [];
  resources = new Map();
  for (const f of files) {
    const u = URL.createObjectURL(f); blobUrls.push(u);
    resources.set(f.name.toLowerCase(), u);
  }
  try {
    let root, notes = [];
    if (isUsdLayer(model.name) || extOf(model.name) === 'usdz') {
      if (await serverAvailable()) {
        const { blob, info } = await convertOnServer(files);        // real OpenUSD
        const url = URL.createObjectURL(blob); blobUrls.push(url);
        root = await parseModel({ name: 'converted.glb' }, url, makeManager());
        notes = ['Converted with OpenUSD', ...(info.warnings || [])];
      }
    }
    if (!root) root = await parseModel(model, resources.get(model.name.toLowerCase()), makeManager(), files);
    root.userData.notes = notes;
    disposeCurrent();
    current = root; pivot.add(root);
    prepare(root, model);
    $('drop').classList.add('hidden');
    $('panel').hidden = false;
  } catch (e) {
    console.error(e);
    showError(`Could not open "${model.name}".\n${e?.message || e}`);
  } finally { setLoading(false); }
}

function prepare(root, file) {
  // Give meshes without materials/normals something sensible to render.
  let tris = 0, meshes = 0; const mats = new Set();
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      meshes++;
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const idx = o.geometry.index;
      tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
      for (const m of [].concat(o.material)) { mats.add(m); m.userData._side = m.side; }
      if (!o.material) o.material = new THREE.MeshStandardMaterial({ color: 0xb8c0cc });
    }
  });
  applyWire(); applyDouble();
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
}

// ---------- UI ----------
function syncUI() {      // apply the checkbox states as shown (the browser/host may restore them)
  grid.visible = $('optGrid').checked; axes.visible = $('optAxes').checked;
  controls.autoRotate = $('optRotate').checked; controls.autoRotateSpeed = 2;
  pivot.rotation.x = $('optZup').checked ? -Math.PI / 2 : 0; pivot.updateMatrixWorld(true);
  scene.background = new THREE.Color($('optBg').value);
  const v = +$('optLight').value; sun.intensity = v; scene.environmentIntensity = 0.6 * v;
  applyWire(); applyDouble();
}
function setLoading(v) { $('loading').hidden = !v; }
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
$('optWire').onchange = applyWire;
$('optDouble').onchange = applyDouble;
$('optRotate').onchange = (e) => { controls.autoRotate = e.target.checked; controls.autoRotateSpeed = 2; };
$('optZup').onchange = (e) => { pivot.rotation.x = e.target.checked ? -Math.PI / 2 : 0; pivot.updateMatrixWorld(true); fitView(); };
$('optBg').onchange = (e) => (scene.background = new THREE.Color(e.target.value));
$('optLight').oninput = (e) => { const v = +e.target.value; sun.intensity = 1.0 * v; scene.environmentIntensity = 0.6 * v; };
$('fitBtn').onclick = fitView;
$('animSel').onchange = (e) => playAnim(+e.target.value);
$('animPlay').onclick = (e) => { paused = !paused; e.target.textContent = paused ? 'Play' : 'Pause'; };
$('shotBtn').onclick = () => {
  renderer.render(scene, camera);
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
