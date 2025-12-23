import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { FilesetResolver, HandLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import './App.css';

// --- Types & Constants ---
const CONFIG = {
  owner: "Huy Hoàng",
  colors: {
    bg: 0x020205, gold: 0xffd700, red: 0x880000, green: 0x004400,
    iceBlue: 0xaaddff, white: 0xffffff, bearBrown: 0x8B4513
  },
  particles: {
    count: 3000, 
    dustCount: 1500, 
    treeHeight: 30, 
    treeRadius: 10,
    snowCount: 2000, 
    snowSpeed: 8,
    giftCount: 20, // Số lượng hộp quà
    bearCount: 8   // Số lượng gấu bông
  },
  camera: { z: 55 },
  gestures: { palmOpenThreshold: 0.35, sensitivity: 6.0 }
};

type Mode = 'TREE' | 'SCATTER' | 'FOCUS' | 'LETTER' | 'NAME_MODE';

interface AppState {
  mode: Mode;
  focusTarget: THREE.Object3D | null;
  currentPhotoIndex: number;
  currentThemeIndex: number; // 0:Gold, 1:Frozen
  gestureDebounceTimer: number;
  scatterScale: number;
  gestureBaseSpread: number | null;
  hand: { detected: boolean; x: number; y: number };
  rotation: { x: number; y: number };
  spinVel: { x: number; y: number };
  time: number;
  wasPointing: boolean;
  palmCenter: { x: number; y: number };
  hasPalmCenter: boolean;
  starMesh: THREE.Mesh | null;
  starHaloMesh: THREE.Mesh | null;
  letterContent: string;
  letterLastTriggerTime: number;
  musicData: string | null;
}

// Particle Class Definition
class Particle {
  mesh: THREE.Mesh | THREE.Group;
  type: string;
  isDust: boolean;
  isTextParticle: boolean = false; 
  posTree: THREE.Vector3;
  posScatter: THREE.Vector3;
  posText: THREE.Vector3; 
  baseScale: number;
  offset: number;
  speed: number;
  baseEmissive?: THREE.Color;
  hasEmissive: boolean = false;

  constructor(mesh: THREE.Mesh | THREE.Group, type: string, isDust: boolean = false) {
    this.mesh = mesh;
    this.type = type;
    this.isDust = isDust;
    this.posTree = new THREE.Vector3();
    this.posScatter = new THREE.Vector3();
    this.posText = new THREE.Vector3(); 
    this.baseScale = mesh.scale.x;
    this.offset = Math.random() * 100;
    this.speed = 0.5 + Math.random();

    if ((mesh as THREE.Mesh).material) {
      const mat = (mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (mat.emissive) {
        this.baseEmissive = mat.emissive.clone();
        this.hasEmissive = true;
      }
    }
    this.calculatePositions();
    this.posText.copy(this.posScatter);
  }

  calculatePositions() {
    const h = CONFIG.particles.treeHeight;
    let t = Math.random();
    
    // Logic xếp cây thông
    if (Math.random() > 0.7 && !this.isDust && this.type !== 'PHOTO' && this.type !== 'GIFT' && this.type !== 'BEAR') {
      const y = (t * h) - h / 2;
      const angle = t * Math.PI * 14; 
      const rBase = CONFIG.particles.treeRadius * (1.0 - t);
      this.posTree.set(Math.cos(angle) * rBase, y, Math.sin(angle) * rBase);
    } else {
      // Hạt thông thường
      t = Math.pow(t, 0.8);
      const y = (t * h) - h / 2;
      const angle = Math.random() * Math.PI * 2;
      const r = Math.max(0.5, CONFIG.particles.treeRadius * (1.0 - t)) * Math.sqrt(Math.random());
      this.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
    }

    const rScatter = this.isDust ? (15 + Math.random() * 25) : (10 + Math.random() * 20);
    const theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1);
    this.posScatter.set(rScatter * Math.sin(phi) * Math.cos(theta), rScatter * Math.sin(phi) * Math.sin(theta), rScatter * Math.cos(phi));
  }

  update(dt: number, time: number, mode: Mode, focusTargetMesh: THREE.Object3D | null, invMatrix: THREE.Matrix4 | null, cameraZ: number, scatterScale: number, themeIndex: number) {
    let target;
    let s = this.baseScale;
    let lerpSpeed = 3.0;

    const _targetVec = new THREE.Vector3();
    const _tempVec = new THREE.Vector3();

    if (mode === 'SCATTER') {
      _targetVec.copy(this.posScatter).multiplyScalar(scatterScale);
      target = _targetVec;
      lerpSpeed = 5.0;
    }
    else if (mode === 'LETTER') {
      target = this.posScatter;
    }
    else if (mode === 'NAME_MODE') {
        // --- LOGIC CHỮ NHIÊN ---
        target = this.posText;
        lerpSpeed = 4.0;
        
        if (this.isTextParticle) {
            s = this.baseScale * 2.5; 
        } else {
            // Hạt thừa (bao gồm cả quà và gấu) sẽ biến mất khi xếp chữ để chữ rõ nhất
            s = 0; 
        }
    }
    else if (mode === 'FOCUS') {
      if (this.mesh === focusTargetMesh && invMatrix) {
        _targetVec.set(0, 0, cameraZ - 15).applyMatrix4(invMatrix);
        target = _targetVec;
        lerpSpeed = 6.0;
        this.mesh.lookAt(new THREE.Vector3(0, 0, cameraZ));
        s = this.baseScale * 5.0;
      } else {
        target = this.posScatter;
        s = 0.01;
      }
    }
    else {
      // Mode TREE
      target = this.posTree;
    }

    _tempVec.copy(target);

    // Hiệu ứng rung rinh
    if (mode === 'TREE' || (mode === 'NAME_MODE' && this.isTextParticle)) {
      _tempVec.y += Math.sin(time * this.speed + this.offset) * 0.15;
      _tempVec.x += Math.cos(time * 0.5 * this.speed + this.offset) * 0.1;
    }

    this.mesh.position.lerp(_tempVec, lerpSpeed * dt);

    // --- LOGIC ĐỔI MÀU (Gesture 2 - Theme Switch) ---
    if (this.hasEmissive && (mode === 'TREE' || mode === 'NAME_MODE') && !this.isDust) {
      const blink = Math.sin(time * 2 + this.offset);
      const mat = (this.mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
      
      let intensity = blink > 0.5 ? (1.0 + (blink - 0.5) * 2.5) : 0.4;
      
      if (mode === 'NAME_MODE' && this.isTextParticle) {
          intensity = 1.5 + blink * 1.0;
          if (themeIndex === 0) { 
             mat.emissive.setHex(0xffaa00); 
          } else { 
             mat.emissive.setHex(0x00ffff); 
          }
      } else {
         if (this.baseEmissive) mat.emissive.copy(this.baseEmissive);
      }
      mat.emissiveIntensity = intensity;
    }

    if (mode !== 'FOCUS') {
      if (this.isDust) s = this.baseScale * (0.5 + 0.5 * Math.sin(time * 3 + this.offset));
      else if ((mode === 'SCATTER' || mode === 'LETTER') && this.type === 'PHOTO') s = this.baseScale * 2.5;
      else if (this.type === 'GIFT' || this.type === 'BEAR') {
         // Quà và gấu giữ nguyên kích thước hoặc scale nhẹ khi bung
         s = this.baseScale;
         if (mode === 'SCATTER') s = this.baseScale * 1.2;
      }
    }
    
    this.mesh.scale.lerp(new THREE.Vector3(s, s, s), 5 * dt);
  }
}

const ChristmasTree: React.FC = () => {
  // UI Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Hidden Inputs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // State Refs
  const stateRef = useRef<AppState>({
    mode: 'TREE', focusTarget: null, currentPhotoIndex: -1,
    currentThemeIndex: 0, gestureDebounceTimer: 0,
    scatterScale: 1.0, gestureBaseSpread: null,
    hand: { detected: false, x: 0, y: 0 },
    rotation: { x: 0, y: 0 }, spinVel: { x: 0, y: 0 }, time: 0,
    wasPointing: false, palmCenter: { x: 0.5, y: 0.5 }, hasPalmCenter: false,
    starMesh: null, starHaloMesh: null,
    letterContent: "Trong khoảnh khắc đặc biệt này,\ntôi muốn nói với bạn rằng,\nbạn chính là dải ngân hà lấp lánh trong mắt tôi.",
    letterLastTriggerTime: 0, musicData: null
  });

  // React State for UI
  const [isLoading, setIsLoading] = useState(true);
  const [showWebcam, setShowWebcam] = useState(false);
  const [showLetterEditor, setShowLetterEditor] = useState(false);
  const [showLetterOverlay, setShowLetterOverlay] = useState(false);
  const [displayedLetter, setDisplayedLetter] = useState("");
  const [isFullScreen, setIsFullScreen] = useState(false);

  // Three.js Objects Refs
  const threeRefs = useRef({
    scene: null as THREE.Scene | null,
    camera: null as THREE.PerspectiveCamera | null,
    renderer: null as THREE.WebGLRenderer | null,
    composer: null as EffectComposer | null,
    mainGroup: null as THREE.Group | null,
    starGroup: null as THREE.Group | null,
    bgGroup: null as THREE.Group | null,
    photoMeshGroup: null as THREE.Group | null,
    particleSystem: [] as Particle[],
    galaxySystem: null as THREE.Points | null,
    snowSystem: null as THREE.Points | null,
    matLib: {} as any,
    caneTexture: null as THREE.Texture | null,
    snowTexture: null as THREE.Texture | null,
    clock: new THREE.Clock()
  });

  // MediaPipe Refs
  const mpRefs = useRef({
    handLandmarker: null as HandLandmarker | null,
    drawingUtils: null as DrawingUtils | null,
    canvasCtx: null as CanvasRenderingContext2D | null,
    lastVideoTime: -1
  });

  // --- Core Logic ---

  useEffect(() => {
    if (!containerRef.current || !videoRef.current || !canvasRef.current) return;

    const T = threeRefs.current;
    const STATE = stateRef.current;

    // 1. Init Three
    T.scene = new THREE.Scene();
    T.scene.background = new THREE.Color(CONFIG.colors.bg);
    T.scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.012);

    T.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);
    T.camera.position.set(0, 0, CONFIG.camera.z);

    T.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", depth: true });
    T.renderer.setSize(window.innerWidth, window.innerHeight);
    T.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    T.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    T.renderer.toneMappingExposure = 1.0;
    containerRef.current.appendChild(T.renderer.domElement);

    T.bgGroup = new THREE.Group(); T.scene.add(T.bgGroup);
    T.mainGroup = new THREE.Group(); T.mainGroup.rotation.x = 0.1; T.scene.add(T.mainGroup);
    T.starGroup = new THREE.Group(); T.mainGroup.add(T.starGroup);
    T.photoMeshGroup = new THREE.Group(); T.mainGroup.add(T.photoMeshGroup);

    // 2. Environment & Lights
    const pmrem = new THREE.PMREMGenerator(T.renderer);
    pmrem.compileEquirectangularShader();
    T.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    T.scene.add(new THREE.AmbientLight(0xffffff, 0.2));
    const bottomLight = new THREE.PointLight(CONFIG.colors.gold, 3, 40);
    bottomLight.position.set(0, -10, 10);
    T.mainGroup.add(bottomLight);

    const spotGold = new THREE.SpotLight(0xfff0dd, 800);
    spotGold.position.set(40, 60, 40); spotGold.angle = 0.4; spotGold.decay = 2;
    T.scene.add(spotGold);

    const spotBlue = new THREE.SpotLight(0x4455ff, 400);
    spotBlue.position.set(-40, 10, -30); spotBlue.lookAt(0, 0, 0);
    T.scene.add(spotBlue);

    // 3. Post Processing
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloom.threshold = 0.75; bloom.strength = 0.5; bloom.radius = 0.5;
    T.composer = new EffectComposer(T.renderer);
    T.composer.addPass(new RenderPass(T.scene, T.camera));
    T.composer.addPass(bloom);

    // 4. Textures & Materials
    const createFrostTexture = () => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 256;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#666'; ctx.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 80; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.5})`;
        ctx.lineWidth = Math.random() * 2 + 0.5;
        ctx.beginPath();
        const x = Math.random() * 256, y = Math.random() * 256;
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60);
        ctx.stroke();
      }
      const imgData = ctx.getImageData(0, 0, 256, 256);
      for (let i = 0; i < imgData.data.length; i += 4) {
        if (Math.random() > 0.9) {
          const noise = Math.random() * 50;
          imgData.data[i] += noise; imgData.data[i + 1] += noise; imgData.data[i + 2] += noise;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
      return tex;
    };

    const canvasCane = document.createElement('canvas'); canvasCane.width = 128; canvasCane.height = 128;
    const ctxCane = canvasCane.getContext('2d')!;
    ctxCane.fillStyle = '#ffffff'; ctxCane.fillRect(0, 0, 128, 128);
    ctxCane.fillStyle = '#aa0000'; ctxCane.beginPath();
    for (let i = -128; i < 256; i += 32) { ctxCane.moveTo(i, 0); ctxCane.lineTo(i + 32, 128); ctxCane.lineTo(i + 16, 128); ctxCane.lineTo(i - 16, 0); }
    ctxCane.fill();
    T.caneTexture = new THREE.CanvasTexture(canvasCane);
    T.caneTexture.colorSpace = THREE.SRGBColorSpace;
    T.caneTexture.wrapS = THREE.RepeatWrapping; T.caneTexture.wrapT = THREE.RepeatWrapping;
    T.caneTexture.repeat.set(3, 3);

    const snowCvs = document.createElement('canvas'); snowCvs.width = 32; snowCvs.height = 32;
    const sCtx = snowCvs.getContext('2d')!;
    const grad = sCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    sCtx.fillStyle = grad; sCtx.fillRect(0, 0, 32, 32);
    T.snowTexture = new THREE.CanvasTexture(snowCvs);

    const frostTex = createFrostTexture();

    T.matLib = {
      gold: new THREE.MeshStandardMaterial({ color: CONFIG.colors.gold, metalness: 1.0, roughness: 0.15, envMapIntensity: 2.5, emissive: 0x664400, emissiveIntensity: 0.2 }),
      green: new THREE.MeshStandardMaterial({ color: CONFIG.colors.green, metalness: 0.4, roughness: 0.3, emissive: 0x001100, emissiveIntensity: 0.1 }),
      red: new THREE.MeshPhysicalMaterial({ color: CONFIG.colors.red, metalness: 0.6, roughness: 0.2, clearcoat: 1.0, emissive: 0x330000, emissiveIntensity: 0.4 }),
      candy: new THREE.MeshStandardMaterial({ map: T.caneTexture, roughness: 0.3, metalness: 0.1, emissive: 0x222222 }),
      starGold: new THREE.MeshStandardMaterial({ color: 0xffdd88, emissive: 0xffaa00, emissiveIntensity: 2.0, metalness: 1.0, roughness: 0 }),
      frameGold: new THREE.MeshStandardMaterial({ color: CONFIG.colors.gold, metalness: 1.0, roughness: 0.2 }),
      ice: new THREE.MeshPhysicalMaterial({
        color: CONFIG.colors.iceBlue, metalness: 0.1, roughness: 0.1, roughnessMap: frostTex,
        transmission: 0.9, thickness: 2.5, ior: 1.5, clearcoat: 1.0, clearcoatRoughnessMap: frostTex,
        emissive: 0x001133, emissiveIntensity: 0.2
      }),
      snowBorder: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.BackSide }),
      starIce: new THREE.MeshPhysicalMaterial({ color: CONFIG.colors.iceBlue, emissive: CONFIG.colors.iceBlue, emissiveIntensity: 1.2, metalness: 0.5, roughness: 0.1, transmission: 0.8, thickness: 2.0, clearcoat: 1.0 }),
      snow: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.0, roughness: 0.9, emissive: 0xaaaaaa, emissiveIntensity: 0.3 }),
      dust: new THREE.MeshBasicMaterial({ color: 0xffffee, blending: THREE.AdditiveBlending }),
      snowFlake: new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, map: T.snowTexture, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
      bearBrown: new THREE.MeshStandardMaterial({ color: CONFIG.colors.bearBrown, roughness: 0.9, metalness: 0.0 }),
      bearWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1, emissive: 0x333333, emissiveIntensity: 0.1 }),
      white: new THREE.MeshStandardMaterial({ color: 0xffffff }),
      blue: new THREE.MeshStandardMaterial({ color: CONFIG.colors.iceBlue })
    };
    T.matLib.frameIce = T.matLib.ice;

    // 5. Create Objects
    // Galaxy
    const gGeo = new THREE.BufferGeometry(), gCount = 3000;
    const gPos = new Float32Array(gCount * 3), gSizes = new Float32Array(gCount), gColors = new Float32Array(gCount * 3);
    const c1 = new THREE.Color(0x88aaff), c2 = new THREE.Color(0xffffee), c3 = new THREE.Color(0xffd700);
    for (let i = 0; i < gCount; i++) {
      const r = 60 + Math.random() * 250, theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1);
      gPos[i * 3] = r * Math.sin(phi) * Math.cos(theta); gPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta); gPos[i * 3 + 2] = r * Math.cos(phi);
      gSizes[i] = Math.random() * 2.0;
      let c = Math.random(), finalC = c < 0.6 ? c2 : (c < 0.9 ? c1 : c3);
      gColors[i * 3] = finalC.r; gColors[i * 3 + 1] = finalC.g; gColors[i * 3 + 2] = finalC.b;
    }
    gGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
    gGeo.setAttribute('size', new THREE.BufferAttribute(gSizes, 1));
    gGeo.setAttribute('color', new THREE.BufferAttribute(gColors, 3));
    T.galaxySystem = new THREE.Points(gGeo, new THREE.PointsMaterial({ size: 1.0, transparent: true, opacity: 0.8, vertexColors: true, sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    T.bgGroup.add(T.galaxySystem);

    // Snow
    const sGeo = new THREE.BufferGeometry();
    const sCount = CONFIG.particles.snowCount;
    const sPos = new Float32Array(sCount * 3);
    const sVel = new Float32Array(sCount);
    for (let i = 0; i < sCount; i++) {
      sPos[i * 3] = (Math.random() - 0.5) * 100; sPos[i * 3 + 1] = (Math.random() - 0.5) * 100; sPos[i * 3 + 2] = (Math.random() - 0.5) * 60;
      sVel[i] = 1.0 + Math.random();
    }
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    sGeo.setAttribute('velocity', new THREE.BufferAttribute(sVel, 1));
    T.snowSystem = new THREE.Points(sGeo, T.matLib.snowFlake);
    T.snowSystem.visible = false;
    T.bgGroup.add(T.snowSystem);

    // Helpers to create Gifts and Bears
    const createGift = () => {
        const group = new THREE.Group();
        // Box Base
        const boxMat = Math.random() > 0.5 ? T.matLib.red : T.matLib.green;
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), boxMat);
        group.add(box);
        
        // Ribbon
        const ribbonMat = T.matLib.gold;
        const r1 = new THREE.Mesh(new THREE.BoxGeometry(1.55, 1.55, 0.3), ribbonMat);
        const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.55, 1.55), ribbonMat);
        group.add(r1); group.add(r2);
        
        return group;
    };

    const createBear = () => {
        const group = new THREE.Group();
        const mat = T.matLib.bearBrown;
        
        // Body
        const body = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16), mat);
        body.position.y = 0;
        group.add(body);
        
        // Head
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 16), mat);
        head.position.y = 1.1;
        group.add(head);

        // Ears
        const earGeo = new THREE.SphereGeometry(0.25, 8, 8);
        const earL = new THREE.Mesh(earGeo, mat); earL.position.set(-0.6, 1.7, 0);
        const earR = new THREE.Mesh(earGeo, mat); earR.position.set(0.6, 1.7, 0);
        group.add(earL); group.add(earR);

        // Arms
        const armGeo = new THREE.SphereGeometry(0.35, 8, 8);
        const armL = new THREE.Mesh(armGeo, mat); armL.position.set(-0.9, 0.2, 0.4);
        const armR = new THREE.Mesh(armGeo, mat); armR.position.set(0.9, 0.2, 0.4);
        group.add(armL); group.add(armR);
        
        return group;
    };

    // Particles Creation
    const sphereGeo = new THREE.SphereGeometry(0.5, 12, 12), boxGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0.1, 0.5, 0), new THREE.Vector3(0.3, 0.4, 0)]);
    const candyGeo = new THREE.TubeGeometry(curve, 8, 0.08, 6, false), dustGeo = new THREE.OctahedronGeometry(0.1, 0);

    for (let i = 0; i < CONFIG.particles.count; i++) {
      const rand = Math.random(); let mesh: THREE.Mesh | THREE.Group, type;
      if (rand < 0.35) { mesh = new THREE.Mesh(boxGeo, T.matLib.green); type = 'BOX'; }
      else if (rand < 0.70) { mesh = new THREE.Mesh(boxGeo, T.matLib.gold); type = 'GOLD_BOX'; }
      else if (rand < 0.90) { mesh = new THREE.Mesh(sphereGeo, T.matLib.gold); type = 'GOLD_SPHERE'; }
      else if (rand < 0.96) { mesh = new THREE.Mesh(sphereGeo, T.matLib.red); type = 'RED'; }
      else { mesh = new THREE.Mesh(candyGeo, T.matLib.candy); type = 'CANE'; }
      
      const s = 0.4 + Math.random() * 0.4; 
      mesh.scale.set(s, s, s);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      mesh.position.set(0, -100, 0); 

      T.mainGroup.add(mesh);
      T.particleSystem.push(new Particle(mesh, type, false));
    }

    // Create Gifts
    for(let i=0; i<CONFIG.particles.giftCount; i++) {
        const gift = createGift();
        const s = 0.8 + Math.random()*0.4;
        gift.scale.set(s,s,s);
        T.mainGroup.add(gift);
        const p = new Particle(gift, 'GIFT', false);
        // Overwrite position to be at tree base
        const angle = Math.random() * Math.PI * 2;
        const r = 4 + Math.random() * 8; 
        p.posTree.set(Math.cos(angle)*r, -CONFIG.particles.treeHeight/2 + 1.0, Math.sin(angle)*r);
        T.particleSystem.push(p);
    }

    // Create Bears
    for(let i=0; i<CONFIG.particles.bearCount; i++) {
        const bear = createBear();
        const s = 1.2 + Math.random()*0.3;
        bear.scale.set(s,s,s);
        T.mainGroup.add(bear);
        const p = new Particle(bear, 'BEAR', false);
        // Overwrite position
        const angle = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 7;
        p.posTree.set(Math.cos(angle)*r, -CONFIG.particles.treeHeight/2 + 1.5, Math.sin(angle)*r);
        // Rotate to look outside
        bear.lookAt(new THREE.Vector3(0, bear.position.y, 0));
        T.particleSystem.push(p);
    }

    for (let i = 0; i < CONFIG.particles.dustCount; i++) {
      const mesh = new THREE.Mesh(dustGeo, T.matLib.dust); mesh.scale.setScalar(0.5 + Math.random());
      T.mainGroup.add(mesh);
      T.particleSystem.push(new Particle(mesh, 'DUST', true));
    }

    // --- GENERATE NAME TEXT ---
    const generateNameText = () => {
      const width = 400; 
      const height = 200;
      const textCanvas = document.createElement('canvas');
      textCanvas.width = width;
      textCanvas.height = height;
      const tCtx = textCanvas.getContext('2d');
      if (!tCtx) return;

      tCtx.fillStyle = '#000000';
      tCtx.fillRect(0, 0, width, height);
      
      tCtx.fillStyle = '#ffffff';
      tCtx.font = 'bold 120px "Times New Roman", serif'; 
      tCtx.textAlign = 'center';
      tCtx.textBaseline = 'middle';
      tCtx.fillText("Nhiên", width / 2, height / 2);

      const imgData = tCtx.getImageData(0, 0, width, height);
      const pixels: THREE.Vector3[] = [];
      
      for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
              const alpha = imgData.data[(y * width + x) * 4];
              if (alpha > 50) { 
                  const posX = (x - width / 2) * 0.12; 
                  const posY = -(y - height / 2) * 0.12 + 5; 
                  const depth = (alpha / 255) * 2.0; 
                  pixels.push(new THREE.Vector3(posX, posY, (Math.random() - 0.5) * 1.5 + depth));
              }
          }
      }

      const shuffledParticles = [...T.particleSystem].sort(() => 0.5 - Math.random());
      
      shuffledParticles.forEach((p, i) => {
          if (i < pixels.length) {
              p.posText.copy(pixels[i]);
              p.isTextParticle = true; 
          } else {
              const r = 30 + Math.random() * 20;
              const theta = Math.random() * Math.PI * 2;
              const phi = Math.acos(2 * Math.random() - 1);
              p.posText.set(
                  r * Math.sin(phi) * Math.cos(theta),
                  r * Math.sin(phi) * Math.sin(theta),
                  r * Math.cos(phi)
              );
              p.isTextParticle = false; 
          }
      });
    };
    generateNameText();

    // Helper: Texture phát sáng
    const createGlowTexture = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d');
      if (context) {
        const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 32, 32);
      }
      return new THREE.CanvasTexture(canvas);
    };

    // Star Object
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), T.matLib.starGold);
    star.position.set(0, CONFIG.particles.treeHeight / 2 + 1.2, 0);

    const haloTexture = createGlowTexture();
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshBasicMaterial({
        map: haloTexture,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.5,
        color: 0xffaa00,
        side: THREE.DoubleSide
      })
    );
    star.add(halo);
    T.starGroup.add(star);
    STATE.starMesh = star;
    STATE.starHaloMesh = halo;

    // Init MediaPipe
    // MediaPipe Prediction
    if (showWebcam && mpRefs.current.handLandmarker && videoRef.current && canvasRef.current) {
      // Chỉ nhận diện khi video đang chạy và có kích thước thật
      if (videoRef.current.readyState >= 2 && videoRef.current.videoWidth > 0) {
          
          // Đồng bộ kích thước hiển thị
          const vWidth = videoRef.current.videoWidth;
          const vHeight = videoRef.current.videoHeight;
          
          if (canvasRef.current.width !== vWidth || canvasRef.current.height !== vHeight) {
              canvasRef.current.width = vWidth;
              canvasRef.current.height = vHeight;
          }

          // Gọi nhận diện
          const startTimeMs = performance.now();
          if (mpRefs.current.lastVideoTime !== videoRef.current.currentTime) {
              mpRefs.current.lastVideoTime = videoRef.current.currentTime;
              
              const result = mpRefs.current.handLandmarker.detectForVideo(videoRef.current, startTimeMs);

              const ctx = mpRefs.current.canvasCtx;
              if (ctx) {
                  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
                  
                  if (result.landmarks && result.landmarks.length > 0) {
                      // Vẽ khung xương
                      mpRefs.current.drawingUtils?.drawConnectors(result.landmarks[0], HandLandmarker.HAND_CONNECTIONS, { color: "#00FF00", lineWidth: 3 });
                      mpRefs.current.drawingUtils?.drawLandmarks(result.landmarks[0], { color: "#FF0000", lineWidth: 2, radius: 3 });
                      
                      // Xử lý logic game
                      processGestures(result.landmarks[0]);
                  } else {
                      STATE.hand.detected = false;
                  }
              }
          }
      }
    }

    // Animation Loop
    let animationId: number;
    const animate = () => {
      if (!T.renderer || !T.scene || !T.camera || !T.composer) return;
      const dt = T.clock.getDelta();
      STATE.time = T.clock.elapsedTime;

      // MediaPipe Prediction
      if (showWebcam && mpRefs.current.handLandmarker && videoRef.current && canvasRef.current) {
        if (videoRef.current.readyState >= 2 && videoRef.current.videoWidth > 0) {
            const vWidth = videoRef.current.videoWidth;
            const vHeight = videoRef.current.videoHeight;
            
            if (canvasRef.current.width !== vWidth || canvasRef.current.height !== vHeight) {
                canvasRef.current.width = vWidth;
                canvasRef.current.height = vHeight;
            }

            if (videoRef.current.currentTime !== mpRefs.current.lastVideoTime) {
                mpRefs.current.lastVideoTime = videoRef.current.currentTime;
                const result = mpRefs.current.handLandmarker.detectForVideo(videoRef.current, performance.now());

                const ctx = mpRefs.current.canvasCtx;
                if (ctx) {
                    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
                    if (result.landmarks && result.landmarks.length > 0) {
                        mpRefs.current.drawingUtils?.drawConnectors(result.landmarks[0], HandLandmarker.HAND_CONNECTIONS, { color: "#00FF00", lineWidth: 3 });
                        mpRefs.current.drawingUtils?.drawLandmarks(result.landmarks[0], { color: "#FF0000", lineWidth: 2, radius: 3 });
                        processGestures(result.landmarks[0]);
                    } else {
                        STATE.hand.detected = false;
                    }
                }
            }
        }
      }

      // Logic Update
      const inputX = STATE.hand.detected ? STATE.hand.x : 0;
      const _invMatrix = new THREE.Matrix4();

      if (STATE.mode === 'LETTER') {
        STATE.rotation.x = THREE.MathUtils.lerp(STATE.rotation.x, Math.PI / 4, dt * 1.5);
        STATE.rotation.y -= 0.1 * dt;
      } else if (STATE.mode === 'NAME_MODE') {
        STATE.rotation.y = THREE.MathUtils.lerp(STATE.rotation.y, 0, dt * 2.0);
        STATE.rotation.x = THREE.MathUtils.lerp(STATE.rotation.x, 0, dt * 2.0);
      } else if (STATE.mode === 'TREE') {
        STATE.rotation.y -= 0.4 * dt;
        STATE.rotation.x = THREE.MathUtils.lerp(STATE.rotation.x, 0.15, dt * 2.0);
        T.mainGroup!.rotation.z = THREE.MathUtils.lerp(T.mainGroup!.rotation.z, inputX * 0.1, dt * 2);
      } else if (STATE.mode === 'SCATTER') {
        STATE.rotation.y += STATE.spinVel.y * dt;
        STATE.rotation.x += STATE.spinVel.x * dt;
        if (!STATE.hand.detected) {
          STATE.spinVel.x *= 0.95; STATE.spinVel.y *= 0.95;
        }
      } else if (STATE.mode === 'FOCUS') {
        _invMatrix.copy(T.mainGroup!.matrixWorld).invert();
      }

      if (T.mainGroup) {
        T.mainGroup.rotation.y = STATE.rotation.y;
        T.mainGroup.rotation.x = STATE.rotation.x;
      }

      if (T.galaxySystem && T.galaxySystem.visible) {
        T.bgGroup!.rotation.y -= 0.05 * dt;
      } else if (T.snowSystem && T.snowSystem.visible) {
        const positions = T.snowSystem.geometry.attributes.position.array as Float32Array;
        const velocities = T.snowSystem.geometry.attributes.velocity.array as Float32Array;
        for (let i = 0; i < CONFIG.particles.snowCount; i++) {
          positions[i * 3 + 1] -= CONFIG.particles.snowSpeed * velocities[i] * dt;
          if (positions[i * 3 + 1] < -50) positions[i * 3 + 1] = 50;
        }
        T.snowSystem.geometry.attributes.position.needsUpdate = true;
        T.bgGroup!.rotation.y -= 0.02 * dt;
      }

      if (STATE.starMesh) {
        if (STATE.mode === 'FOCUS' && STATE.focusTarget === STATE.starMesh) {
            const targetPos = new THREE.Vector3(0, 0, CONFIG.camera.z - 15).applyMatrix4(_invMatrix);
            STATE.starMesh.position.lerp(targetPos, dt * 5.0);
            STATE.starMesh.lookAt(new THREE.Vector3(0, 0, CONFIG.camera.z));
            STATE.starMesh.scale.lerp(new THREE.Vector3(3.0, 3.0, 3.0), dt * 5.0);
        } else {
            const originalY = CONFIG.particles.treeHeight / 2 + 1.2;
            STATE.starMesh.position.lerp(new THREE.Vector3(0, originalY, 0), dt * 3.0);
            STATE.starMesh.rotation.y -= dt;
            STATE.starMesh.rotation.z = Math.sin(STATE.time) * 0.2;
            const s = 1.0 + Math.sin(STATE.time * 2) * 0.1;
            STATE.starMesh.scale.lerp(new THREE.Vector3(s, s, s), dt * 3.0);
        }
      }

      T.particleSystem.forEach(p => {
        p.update(dt, STATE.time, STATE.mode, STATE.focusTarget, (STATE.mode === 'FOCUS' ? _invMatrix : null), CONFIG.camera.z, STATE.scatterScale, STATE.currentThemeIndex);
      });
      T.composer.render();
      animationId = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => {
      T.camera!.aspect = window.innerWidth / window.innerHeight;
      T.camera!.updateProjectionMatrix();
      T.renderer!.setSize(window.innerWidth, window.innerHeight);
      T.composer!.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationId);
      if (containerRef.current && T.renderer) {
        containerRef.current.removeChild(T.renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Interaction Logic ---

  const switchTheme = (themeIndex: number) => {
    const T = threeRefs.current;
    const STATE = stateRef.current;
    STATE.currentThemeIndex = themeIndex;
    T.renderer!.toneMappingExposure = (themeIndex === 1) ? 0.6 : 1.0;
    const isGold = (themeIndex === 0);

    if (T.galaxySystem) T.galaxySystem.visible = isGold;
    if (T.snowSystem) T.snowSystem.visible = !isGold;

    T.particleSystem.forEach(p => {
      if (p.isDust) return;
      if (p.type === 'PHOTO') {
        const group = p.mesh as THREE.Group;
        if (group.children[0]) (group.children[0] as THREE.Mesh).material = isGold ? T.matLib.frameGold : T.matLib.ice;
        if (group.children[2]) group.children[2].visible = !isGold;
        return;
      }
      
      // Xử lý đổi màu Gấu và Quà
      if (p.type === 'GIFT') {
          const group = p.mesh as THREE.Group;
          // Box is children[0], Ribbon is children[1], [2]
          if (group.children[0]) {
              const boxMesh = group.children[0] as THREE.Mesh;
              if (isGold) {
                  boxMesh.material = Math.random() > 0.5 ? T.matLib.red : T.matLib.green;
              } else {
                  boxMesh.material = Math.random() > 0.5 ? T.matLib.blue : T.matLib.white;
              }
          }
          if (group.children[1]) (group.children[1] as THREE.Mesh).material = isGold ? T.matLib.gold : T.matLib.ice;
          if (group.children[2]) (group.children[2] as THREE.Mesh).material = isGold ? T.matLib.gold : T.matLib.ice;
          return;
      }

      if (p.type === 'BEAR') {
          const group = p.mesh as THREE.Group;
          const bearMat = isGold ? T.matLib.bearBrown : T.matLib.bearWhite;
          group.children.forEach(c => {
              if (c instanceof THREE.Mesh) c.material = bearMat;
          });
          return;
      }

      let newMat;
      if (isGold) {
        if (p.type.includes('GOLD')) newMat = T.matLib.gold;
        else if (p.type === 'BOX') newMat = T.matLib.green;
        else if (p.type === 'RED') newMat = T.matLib.red;
        else if (p.type === 'CANE') newMat = T.matLib.candy;
      } else {
        if (p.type.includes('GOLD') || p.type === 'BOX') newMat = T.matLib.ice;
        else if (p.type === 'RED') newMat = T.matLib.snow;
        else if (p.type === 'CANE') newMat = T.matLib.ice;
      }
      if (newMat) (p.mesh as THREE.Mesh).material = newMat;
    });

    if (STATE.starMesh && STATE.starHaloMesh) {
      (STATE.starMesh as THREE.Mesh).material = isGold ? T.matLib.starGold : T.matLib.starIce;
      ((STATE.starHaloMesh as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(isGold ? 0xffaa00 : CONFIG.colors.iceBlue);
    }
  };

  const processGestures = (lm: any[]) => {
    const STATE = stateRef.current;
    if (STATE.mode === 'LETTER') return;

    STATE.hand.detected = true;
    const dist = (i: number, j: number) => Math.hypot(lm[i].x - lm[j].x, lm[i].y - lm[j].y);
    const dIndex = dist(8, 0), dMiddle = dist(12, 0), dRing = dist(16, 0), dPinky = dist(20, 0);
    const palmSize = dist(0, 9);
    
    const avgSpread = (dIndex + dMiddle + dRing + dPinky) / 4;
    const isPalmOpen = avgSpread > CONFIG.gestures.palmOpenThreshold;

    if (dist(4, 8) < 0.05 && dMiddle > 0.15 && dMiddle > dIndex * 1.2) {
      if (Date.now() - STATE.letterLastTriggerTime > 1000) {
        STATE.letterLastTriggerTime = Date.now();
        handleOpenLetterMode();
      }
      return;
    }

    // --- 1. CỬ CHỈ 3 NGÓN (BẬT CHẾ ĐỘ TÊN) ---
    const isThreeFingers = dIndex > palmSize * 1.5 && dMiddle > palmSize * 1.5 && dRing > palmSize * 1.5 && dPinky < palmSize * 1.0;

    if (isThreeFingers) {
        if (STATE.mode !== 'NAME_MODE') {
            STATE.mode = 'NAME_MODE';
            STATE.spinVel.x = 0; STATE.spinVel.y = 0;
        }
        return; 
    }

    // --- 2. CỬ CHỈ NẮM TAY (THOÁT VỀ CÂY) ---
    const isFist = dIndex < palmSize * 0.8 && dMiddle < palmSize * 0.8 && dRing < palmSize * 0.8 && dPinky < palmSize * 0.8;
    
    if (isFist) {
        if (STATE.mode === 'NAME_MODE' || STATE.mode === 'SCATTER') {
            STATE.mode = 'TREE';
        }
        return;
    }

    // --- 3. CỬ CHỈ V-SIGN (ĐỔI MÀU / THEME) ---
    // QUAN TRỌNG: Đặt logic này TRƯỚC khi return NAME_MODE để có thể đổi màu khi đang hiện chữ
    const isVHigh = dIndex > palmSize * 1.3 && dMiddle > palmSize * 1.3;
    const isOthersLow = dRing < dIndex * 0.5 && dPinky < dMiddle * 0.5;
    const isSpread = dist(8, 12) > dist(5, 9) * 1.2;

    if (isVHigh && isOthersLow && isSpread) {
      if (Date.now() - STATE.gestureDebounceTimer > 2000) {
        switchTheme((STATE.currentThemeIndex + 1) % 2);
        STATE.gestureDebounceTimer = Date.now();
      }
    }

    // --- XỬ LÝ RIÊNG CHO NAME MODE: MỞ TAY THÌ BUNG RA ---
    if (STATE.mode === 'NAME_MODE') {
        if (isPalmOpen) {
            // Mở tay -> Cho phép xuống logic SCATTER
        } else {
            // Chưa mở tay -> Giữ nguyên chữ, return để chặn các cử chỉ khác làm rối
            return; 
        }
    }

    // Pointing (Focus Mode)
    const isPointing = dIndex > 0.1 && dMiddle < dIndex * 0.7 && dRing < dIndex * 0.7;

    if (isPointing) {
      STATE.mode = 'FOCUS';
      if (!STATE.wasPointing) {
          const photos = threeRefs.current.particleSystem.filter(p => p.type === 'PHOTO');
          STATE.currentPhotoIndex++;
          if (STATE.currentPhotoIndex < photos.length) {
              STATE.focusTarget = photos[STATE.currentPhotoIndex].mesh;
          } else {
              STATE.focusTarget = STATE.starMesh;
              STATE.currentPhotoIndex = -1;
          }
      }
      STATE.wasPointing = true; STATE.hasPalmCenter = false; STATE.spinVel.x *= 0.9; STATE.spinVel.y *= 0.9;
    } else {
      STATE.wasPointing = false;
      if (isPalmOpen) {
        // --- LOGIC BUNG RA (SCATTER) ---
        if (STATE.mode !== 'SCATTER' || !STATE.hasPalmCenter) {
          STATE.palmCenter = { x: lm[9].x, y: lm[9].y };
          STATE.hasPalmCenter = true;
          STATE.gestureBaseSpread = avgSpread;
          STATE.scatterScale = 1.0;
        }
        STATE.mode = 'SCATTER'; 
        if (STATE.gestureBaseSpread) {
          STATE.scatterScale += (THREE.MathUtils.clamp(Math.pow(STATE.gestureBaseSpread / avgSpread, 2), 0.1, 5.0) - STATE.scatterScale) * 0.15;
        }
        const gain = CONFIG.gestures.sensitivity, dx = lm[9].x - STATE.palmCenter.x, dy = lm[9].y - STATE.palmCenter.y;
        STATE.spinVel.x += (THREE.MathUtils.clamp(-dy * gain, -3, 3) - STATE.spinVel.x) * 0.2;
        STATE.spinVel.y += (THREE.MathUtils.clamp(dx * gain, -3, 3) - STATE.spinVel.y) * 0.2;
      } else {
        if(STATE.mode !== 'NAME_MODE') { 
             STATE.mode = 'TREE'; STATE.hasPalmCenter = false; STATE.scatterScale = 1.0;
             STATE.spinVel.x *= 0.9; STATE.spinVel.y *= 0.9;
        }
      }
    }

    if (STATE.mode !== 'FOCUS' && STATE.mode !== 'NAME_MODE') {
      STATE.hand.x += ((lm[9].x - 0.5) * 3.0 - STATE.hand.x) * 0.1;
      STATE.hand.y += ((lm[9].y - 0.5) * 3.0 - STATE.hand.y) * 0.1;
    }
  };

  const addPhotoToScene = (texture: THREE.Texture) => {
    if (!texture.image) return;
    const aspect = texture.image.width / texture.image.height;
    let photoW = (aspect >= 1) ? 1.2 : 1.2 * aspect, photoH = (aspect >= 1) ? 1.2 / aspect : 1.2;

    const group = new THREE.Group();
    const frameGeo = new THREE.BoxGeometry(photoW + 0.15, photoH + 0.15, 0.1);
    const currentFrameMat = (stateRef.current.currentThemeIndex === 0) ? threeRefs.current.matLib.frameGold : threeRefs.current.matLib.ice;
    const frame = new THREE.Mesh(frameGeo, currentFrameMat);
    group.add(frame);

    const photo = new THREE.Mesh(new THREE.PlaneGeometry(photoW, photoH), new THREE.MeshBasicMaterial({ map: texture }));
    photo.position.z = 0.06; group.add(photo);

    const borderGeo = new THREE.BoxGeometry(photoW + 0.25, photoH + 0.25, 0.08);
    const border = new THREE.Mesh(borderGeo, threeRefs.current.matLib.snowBorder);
    border.position.z = -0.02; border.visible = (stateRef.current.currentThemeIndex !== 0);
    group.add(border);

    threeRefs.current.photoMeshGroup?.add(group);
    threeRefs.current.particleSystem.push(new Particle(group, 'PHOTO', false));
  };

  // --- UI Handlers ---

  const handleAddPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    Array.from(e.target.files).forEach(f => {
      const reader = new FileReader();
      reader.onload = (ev) => new THREE.TextureLoader().load(ev.target!.result as string, t => {
        t.colorSpace = THREE.SRGBColorSpace;
        addPhotoToScene(t);
      });
      reader.readAsDataURL(f);
    });
  };

  const handleMusicUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const reader = new FileReader();
      reader.onload = function (evt) {
        stateRef.current.musicData = evt.target!.result as string;
        if (audioRef.current) {
          audioRef.current.src = evt.target!.result as string;
          audioRef.current.currentTime = 0;
          audioRef.current.play().catch(console.warn);
        }
      };
      reader.readAsDataURL(e.target.files[0]);
    }
  };

  const handleExport = () => {
    const photos = threeRefs.current.particleSystem.filter(p => p.type === 'PHOTO').map(p => {
      try {
        const mesh = (p.mesh as THREE.Group).children[1] as THREE.Mesh;
        const mat = mesh.material as THREE.MeshBasicMaterial;
        return mat.map?.image.src;
      } catch (e) { return null; }
    }).filter(src => src !== null);

    const exportData = {
      owner: CONFIG.owner,
      music: stateRef.current.musicData,
      letter: stateRef.current.letterContent,
      photos: photos,
      theme: stateRef.current.currentThemeIndex
    };

    const blob = new Blob([JSON.stringify(exportData)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "huy_hoang_tree_data.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = JSON.parse(evt.target!.result as string);
          stateRef.current.letterContent = data.letter || stateRef.current.letterContent;
          if (data.music) {
            stateRef.current.musicData = data.music;
            if (audioRef.current) {
              audioRef.current.src = data.music;
              audioRef.current.currentTime = 0;
              audioRef.current.play().catch(console.warn);
            }
          }
          const photosToRemove = threeRefs.current.particleSystem.filter(p => p.type === 'PHOTO');
          photosToRemove.forEach(p => {
            threeRefs.current.photoMeshGroup?.remove(p.mesh);
          });
          threeRefs.current.particleSystem = threeRefs.current.particleSystem.filter(p => p.type !== 'PHOTO');

          if (data.photos && Array.isArray(data.photos)) {
            const loader = new THREE.TextureLoader();
            data.photos.forEach((src: string) => {
              loader.load(src, t => {
                t.colorSpace = THREE.SRGBColorSpace;
                addPhotoToScene(t);
              });
            });
          }
          if (data.theme !== undefined) switchTheme(data.theme);
        } catch (e) {
          alert("Lỗi định dạng tệp!");
        }
      };
      reader.readAsText(e.target.files[0]);
    }
  };

  const handleOpenLetterMode = () => {
    if (stateRef.current.mode === 'LETTER') return;
    stateRef.current.mode = 'LETTER';
    setShowLetterOverlay(true);
    setDisplayedLetter("");
    const fullText = stateRef.current.letterContent;
    let i = 0;
    setTimeout(() => {
      const type = () => {
        if (stateRef.current.mode !== 'LETTER') return;
        if (i < fullText.length) {
          setDisplayedLetter(prev => prev + fullText.charAt(i));
          i++;
          setTimeout(type, 100);
        }
      };
      type();
    }, 1500);
  };

  const handleCloseLetterMode = () => {
    stateRef.current.mode = 'TREE';
    setShowLetterOverlay(false);
    stateRef.current.spinVel.x = 0;
    stateRef.current.spinVel.y = 0;
  };

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullScreen(true);
    } else {
      document.exitFullscreen();
      setIsFullScreen(false);
    }
  };

  return (
    <div className="tree-container">
      <div className={`loader ${isLoading ? '' : 'hidden'}`}>
        <div className="spinner"></div>
      </div>

      <div ref={containerRef} id="canvas-container"></div>

      <div id="ui-layer">
        <div className="top-right-controls">
          {!isFullScreen && (
            <div className="control-col">
              <button onClick={() => musicInputRef.current?.click()} className="control-btn">Tải nhạc</button>
              <button onClick={() => fileInputRef.current?.click()} className="control-btn">Tải ảnh</button>
              <button onClick={() => setShowLetterEditor(true)} className="control-btn">Tâm thư</button>
            </div>
          )}
          <div className="control-col">
            {!isFullScreen && <button onClick={() => importInputRef.current?.click()} className="control-btn">Nhập file</button>}
            {!isFullScreen && <button onClick={handleExport} className="control-btn">Xuất file</button>}
            <button onClick={toggleFullScreen} className="control-btn">{isFullScreen ? 'Thoát' : 'Toàn màn hình'}</button>
          </div>
        </div>

        <input type="file" ref={fileInputRef} multiple accept="image/*" style={{ display: 'none' }} onChange={handleAddPhoto} />
        <input type="file" ref={musicInputRef} accept="audio/*" style={{ display: 'none' }} onChange={handleMusicUpload} />
        <input type="file" ref={importInputRef} accept=".json" style={{ display: 'none' }} onChange={handleImport} />
      </div>

      {showLetterEditor && (
        <div className="letter-editor-modal">
          <h3>Viết tâm tư của bạn</h3>
          <textarea
            className="letter-text-input"
            defaultValue={stateRef.current.letterContent}
            onChange={(e) => stateRef.current.letterContent = e.target.value}
          />
          <div className="modal-btn-group">
            <button onClick={() => setShowLetterEditor(false)} className="control-btn" style={{ width: '80px' }}>Hủy</button>
            <button onClick={() => setShowLetterEditor(false)} className="control-btn" style={{ width: '80px' }}>Lưu</button>
          </div>
        </div>
      )}

      <div className={`letter-overlay ${showLetterOverlay ? 'visible' : ''}`}>
        <div className="letter-paper">
          <div onClick={handleCloseLetterMode} className="letter-close-btn">×</div>
          <div className={`letter-content cursor`}>
            {displayedLetter}
          </div>
        </div>
      </div>

      <div className={`webcam-wrapper ${showWebcam ? 'visible' : ''}`}>
        <video
          ref={videoRef}
          id="webcam"
          autoPlay
          playsInline
          muted
          width="640"
          height="480"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        ></video>
        <canvas
          ref={canvasRef}
          id="webcam-preview"
          width="640"
          height="480"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        ></canvas>
      </div>

      <audio ref={audioRef} id="bg-music" loop crossOrigin="anonymous"></audio>
    </div>
  );
};

export default ChristmasTree;