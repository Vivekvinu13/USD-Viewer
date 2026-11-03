import * as THREE from 'three';

/** A photo-studio lighting rig: dark dome plus bright soft-boxes (used as the reflection/light environment). */
export function makeStudioScene() {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x23262c, side: THREE.BackSide })));
  const panel = (w, h, pos, power, tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(power), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m);
  };
  panel(34, 24, [-28, 22, 30], 7);           // key light, front-left, high
  panel(10, 40, [34, 6, 18], 4.5);           // right strip light
  panel(10, 40, [-38, 6, -8], 3.5);          // left strip light
  panel(46, 46, [0, 44, 0], 2.2);            // top fill
  panel(36, 12, [0, 12, -40], 5);            // back / rim light
  panel(50, 8, [0, 3, 42], 1.2, 0xdfe8ff);   // soft front fill
  return s;
}

/** Render a scene into a cube texture (works for both normal rendering and the path tracer). */
export function cubeEnvFromScene(renderer, scene, size = 256) {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
  });
  const cam = new THREE.CubeCamera(0.1, 300, rt);
  cam.update(renderer, scene);
  return rt.texture;
}

/** Equirectangular HDR environment from a scene (the format the path tracer and raster viewer both accept). */
export function envFromScene(renderer, scene, cubeSize = 256, w = 1024, h = 512) {
  const cube = cubeEnvFromScene(renderer, scene, cubeSize);
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  rt.texture.mapping = THREE.EquirectangularReflectionMapping;
  const mat = new THREE.ShaderMaterial({
    uniforms: { tCube: { value: cube } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform samplerCube tCube; varying vec2 vUv;
      void main(){
        float phi = (vUv.x - 0.5) * 6.28318530718;
        float theta = (vUv.y - 0.5) * 3.14159265359;
        vec3 d = vec3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));
        gl_FragColor = vec4(textureCube(tCube, d).rgb, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const qs = new THREE.Scene(); qs.add(quad);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(qs, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  // read back into a plain DataTexture (what the path tracer's importance sampling needs)
  const data = new Uint16Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, data);
  renderer.setRenderTarget(prev);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType,
    THREE.EquirectangularReflectionMapping, THREE.RepeatWrapping, THREE.ClampToEdgeWrapping,
    THREE.LinearFilter, THREE.LinearFilter);
  tex.needsUpdate = true;
  mat.dispose(); quad.geometry.dispose(); rt.dispose(); cube.dispose?.();
  return tex;
}
