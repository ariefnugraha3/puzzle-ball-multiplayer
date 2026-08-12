import * as THREE from 'three';

import { createSeededRandom } from './game-logic.js';

export class ThreeAtmosphere {
  constructor(container, reducedMotion = false) {
    this.container = container;
    this.reducedMotion = reducedMotion;
    this.pointer = { x: 0, y: 0 };
    this.raf = null;
    this.disposables = [];
    this.onResize = this.resize.bind(this);
    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onVisibility = this.handleVisibility.bind(this);
  }

  init() {
    try {
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2(0x03110f, 0.105);
      this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 40);
      this.camera.position.set(0, 0, 7.8);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.domElement.setAttribute('aria-hidden', 'true');
      this.container.appendChild(this.renderer.domElement);
      this.world = new THREE.Group();
      this.scene.add(this.world);
      this.createStarField();
      this.createTempleRings();
      window.addEventListener('resize', this.onResize);
      window.addEventListener('pointermove', this.onPointerMove, { passive: true });
      document.addEventListener('visibilitychange', this.onVisibility);
      this.resize();
      this.start();
    } catch (error) {
      console.warn('Three.js atmosphere dinonaktifkan:', error);
      this.dispose();
    }
  }

  createStarField() {
    const random = createSeededRandom(9331);
    const positions = [];
    const colors = [];
    const jade = new THREE.Color(0x72e5b0);
    const gold = new THREE.Color(0xf6c85f);
    const color = new THREE.Color();
    for (let index = 0; index < 720; index += 1) {
      positions.push((random() - 0.5) * 15, (random() - 0.5) * 9, -2 - random() * 12);
      color.lerpColors(jade, gold, random() * 0.5);
      colors.push(color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.035,
      transparent: true,
      opacity: 0.68,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.stars = new THREE.Points(geometry, material);
    this.world.add(this.stars);
    this.disposables.push(geometry, material);
  }

  createTempleRings() {
    this.ringGroup = new THREE.Group();
    this.world.add(this.ringGroup);
    for (let index = 0; index < 6; index += 1) {
      const geometry = new THREE.TorusGeometry(2.1 + index * 0.72, 0.022 + index * 0.006, 8, 96);
      const material = new THREE.MeshBasicMaterial({
        color: index % 2 === 0 ? 0x4bc691 : 0xc7913f,
        transparent: true,
        opacity: Math.max(0.025, 0.115 - index * 0.013),
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const ring = new THREE.Mesh(geometry, material);
      ring.position.z = -2.8 - index * 0.52;
      ring.rotation.x = 0.14 + index * 0.035;
      ring.rotation.y = -0.08 + index * 0.025;
      this.ringGroup.add(ring);
      this.disposables.push(geometry, material);
    }
  }

  handlePointerMove(event) {
    this.pointer.x = (event.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
    this.pointer.y = (event.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
  }

  resize() {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  start() {
    if (this.raf !== null || !this.renderer || document.hidden) return;
    this.raf = requestAnimationFrame((time) => this.animate(time));
  }

  animate(time) {
    this.raf = null;
    if (!this.renderer || document.hidden) return;
    const motion = this.reducedMotion ? 0.12 : 1;
    const seconds = time * 0.001;
    this.ringGroup.rotation.z = seconds * 0.025 * motion;
    this.ringGroup.rotation.x = Math.sin(seconds * 0.15) * 0.06 * motion;
    this.stars.rotation.z = -seconds * 0.006 * motion;
    this.world.rotation.y += (this.pointer.x * 0.018 - this.world.rotation.y) * 0.018 * motion;
    this.world.rotation.x += (-this.pointer.y * 0.012 - this.world.rotation.x) * 0.018 * motion;
    this.renderer.render(this.scene, this.camera);
    this.start();
  }

  handleVisibility() {
    if (document.hidden && this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    } else this.start();
  }

  dispose() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.disposables.forEach((item) => item.dispose?.());
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
    this.renderer = null;
  }
}
