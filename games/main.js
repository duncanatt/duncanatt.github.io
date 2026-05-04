const canvas = document.querySelector("#game");
const gl = canvas.getContext("webgl", { antialias: true });
const scoreEl = document.querySelector("#score");
const bestScoreEl = document.querySelector("#bestScore");
const waveEl = document.querySelector("#wave");
const destroyedEl = document.querySelector("#destroyed");
const accuracyEl = document.querySelector("#accuracy");
const healthBar = document.querySelector("#healthBar");
const overlay = document.querySelector("#overlay");
const startButton = document.querySelector("#startButton");
const toast = document.querySelector("#toast");
const waveFlash = document.querySelector("#waveFlash");
const waveBanner = document.querySelector("#waveBanner");
const mobileControls = document.querySelector("#mobileControls");
const moveStick = document.querySelector("#moveStick");
const moveKnob = document.querySelector("#moveKnob");
const touchLock = document.querySelector("#touchLock");
const touchFire = document.querySelector("#touchFire");

if (!gl) {
  overlay.querySelector("h1").textContent = "WebGL unavailable";
  overlay.querySelector("p:not(.kicker)").textContent = "This 3D version needs WebGL enabled in your browser.";
  startButton.disabled = true;
  throw new Error("WebGL unavailable");
}

const WORLD_LIMIT = 72;
const STORAGE_KEY = "ufoTankShooterRawWebglStats";
const keys = new Set();
const pointer = { x: 0, y: 0, worldX: 0, worldZ: -18, down: false };
const touchMove = { x: 0, z: 0, active: false, pointerId: null };
const camera = { x: 0, y: 24, z: 44, tx: 0, ty: 2.5, tz: -10 };

let running = false;
let lastTime = 0;
let toastTimer = 0;
let pixelRatio = 1;
let audioCtx = null;
let masterGain = null;
let ambience = null;

const saved = readSavedStats();
const state = {
  score: 0,
  bestScore: saved.bestScore,
  wave: 1,
  health: 100,
  shots: 0,
  hits: 0,
  destroyed: 0,
  waveDestroyed: 0,
  waveTotal: 0,
  shake: 0,
  tank: {
    x: 0,
    y: 0,
    z: 10,
    vx: 0,
    vz: 0,
    bodyAngle: Math.PI,
    turretAngle: Math.PI,
    cooldown: 0,
    destroyed: false,
  },
  enemies: [],
  bullets: [],
  enemyShots: [],
  explosions: [],
  pickups: [],
  shrubs: [],
  rocks: [],
  stars: [],
  constellations: [],
  target: null,
};

const program = createProgram(
  `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  attribute vec3 aColor;
  uniform mat4 uModel;
  uniform mat4 uView;
  uniform mat4 uProjection;
  uniform vec3 uLight;
  uniform float uPointSize;
  varying vec3 vColor;
  void main() {
    vec3 n = normalize(mat3(uModel) * aNormal);
    float normalLength = length(aNormal);
    float lit = normalLength < 0.1 ? 1.0 : 0.34 + max(dot(n, normalize(uLight)), 0.0) * 0.78;
    vColor = aColor * lit;
    gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
    gl_PointSize = uPointSize;
  }
  `,
  `
  precision mediump float;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
  `,
);

const loc = {
  position: gl.getAttribLocation(program, "aPosition"),
  normal: gl.getAttribLocation(program, "aNormal"),
  color: gl.getAttribLocation(program, "aColor"),
  model: gl.getUniformLocation(program, "uModel"),
  view: gl.getUniformLocation(program, "uView"),
  projection: gl.getUniformLocation(program, "uProjection"),
  light: gl.getUniformLocation(program, "uLight"),
  pointSize: gl.getUniformLocation(program, "uPointSize"),
};

const meshes = {
  cube: createMesh(boxGeometry(), gl.TRIANGLES),
  cylinder: createMesh(cylinderGeometry(18), gl.TRIANGLES),
  cone: createMesh(coneGeometry(18), gl.TRIANGLES),
  sphere: createMesh(sphereGeometry(18, 10), gl.TRIANGLES),
  terrain: createMesh(terrainGeometry(), gl.TRIANGLES),
  stars: null,
  constellationLines: null,
};

gl.useProgram(program);
gl.enable(gl.DEPTH_TEST);
gl.disable(gl.CULL_FACE);
gl.clearColor(0.02, 0.05, 0.1, 1);
gl.uniform3f(loc.light, -0.4, 0.85, 0.35);

resetWorld();
resize();
requestAnimationFrame(loop);

function readSavedStats() {
  try {
    return { bestScore: 0, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { bestScore: 0 };
  }
}

function saveStats() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ bestScore: state.bestScore }));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function ensureAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.32;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  if (!ambience) startAmbience();
  return true;
}

function startAmbience() {
  if (!audioCtx || !masterGain) return;
  const hum = audioCtx.createOscillator();
  const pulse = audioCtx.createOscillator();
  const humGain = audioCtx.createGain();
  const pulseGain = audioCtx.createGain();
  hum.type = "sine";
  pulse.type = "triangle";
  hum.frequency.value = 54;
  pulse.frequency.value = 0.13;
  humGain.gain.value = 0.018;
  pulseGain.gain.value = 0.008;
  hum.connect(humGain);
  pulse.connect(pulseGain);
  humGain.connect(masterGain);
  pulseGain.connect(masterGain);
  hum.start();
  pulse.start();
  ambience = { hum, pulse };
}

function tone(freq, duration, type = "sine", volume = 0.12, slideTo = freq, delay = 0) {
  if (!ensureAudio()) return;
  const now = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + duration + 0.04);
}

function noiseBurst(duration, volume, color = "white", delay = 0) {
  if (!ensureAudio()) return;
  const now = audioCtx.currentTime + delay;
  const sampleRate = audioCtx.sampleRate;
  const buffer = audioCtx.createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = color === "brown" ? last * 0.86 + white * 0.14 : white;
    data[i] = last;
  }
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  filter.type = color === "brown" ? "lowpass" : "bandpass";
  filter.frequency.value = color === "brown" ? 260 : 1180;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.buffer = buffer;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  source.start(now);
  source.stop(now + duration + 0.04);
}

function playSound(name) {
  if (!ensureAudio()) return;
  if (name === "tankFire") {
    tone(760, 0.12, "square", 0.09, 210);
    noiseBurst(0.08, 0.045, "white");
  } else if (name === "enemyFire") {
    tone(220, 0.16, "sawtooth", 0.07, 520);
  } else if (name === "hit") {
    tone(180, 0.16, "triangle", 0.09, 70);
    noiseBurst(0.14, 0.07, "brown");
  } else if (name === "explosion") {
    tone(92, 0.38, "sawtooth", 0.11, 36);
    noiseBurst(0.32, 0.13, "brown");
  } else if (name === "pickup") {
    tone(520, 0.09, "sine", 0.08, 760);
    tone(880, 0.12, "sine", 0.07, 1220, 0.08);
  } else if (name === "wave") {
    tone(160, 0.2, "triangle", 0.07, 320);
    tone(320, 0.24, "triangle", 0.06, 640, 0.12);
  } else if (name === "damage") {
    tone(105, 0.28, "sawtooth", 0.11, 55);
    noiseBurst(0.18, 0.09, "brown");
  } else if (name === "regrow") {
    tone(340, 0.15, "sine", 0.055, 540);
    tone(620, 0.12, "sine", 0.045, 820, 0.08);
  }
}

function resetWorld() {
  state.score = 0;
  state.wave = 1;
  state.health = 100;
  state.shots = 0;
  state.hits = 0;
  state.destroyed = 0;
  state.waveDestroyed = 0;
  state.waveTotal = 0;
  state.shake = 0;
  state.tank.x = 0;
  state.tank.y = tankGroundY(0, 10);
  state.tank.z = 10;
  state.tank.vx = 0;
  state.tank.vz = 0;
  state.tank.bodyAngle = Math.PI;
  state.tank.turretAngle = Math.PI;
  state.tank.cooldown = 0;
  state.tank.destroyed = false;
  state.enemies = [];
  state.bullets = [];
  state.enemyShots = [];
  state.explosions = [];
  state.pickups = [];
  state.target = null;
  state.shrubs = makeShrubs();
  state.rocks = makeRocks();
  state.stars = makeStars();
  state.constellations = makeConstellations();
  meshes.stars = createMesh(starGeometry(state.stars), gl.POINTS);
  meshes.constellationLines = createMesh(constellationGeometry(state.constellations), gl.LINES);
  spawnWave();
  updateHud();
}

function makeShrubs() {
  const shrubs = [];
  for (let i = 0; i < 88; i += 1) {
    const x = rand(-WORLD_LIMIT, WORLD_LIMIT);
    const z = rand(-WORLD_LIMIT, WORLD_LIMIT);
    if (Math.hypot(x, z - 10) < 12) continue;
    const roll = Math.random();
    shrubs.push({
      x,
      z,
      scale: rand(1.05, 2.35),
      kind: roll < 0.48 ? "pine" : roll < 0.74 ? "tree" : "bush",
      lean: rand(-0.22, 0.22),
      colorShift: rand(-0.06, 0.08),
      maxHp: roll < 0.74 ? 2 : 1,
      hp: roll < 0.74 ? 2 : 1,
      radius: roll < 0.74 ? 1.35 : 1.05,
      dead: false,
      regrowTimer: 0,
      regrowDuration: rand(18, 32),
    });
  }
  return shrubs;
}

function makeRocks() {
  const rocks = [];
  for (let i = 0; i < 42; i += 1) {
    const x = rand(-WORLD_LIMIT, WORLD_LIMIT);
    const z = rand(-WORLD_LIMIT, WORLD_LIMIT);
    if (Math.hypot(x, z - 10) < 14) continue;
    rocks.push({
      x,
      z,
      scale: rand(0.55, 1.8),
      yaw: rand(0, Math.PI * 2),
      tint: rand(-0.05, 0.08),
    });
  }
  return rocks;
}

function makeStars() {
  return Array.from({ length: 170 }, () => ({
    x: rand(-82, 82),
    y: rand(28, 55),
    z: rand(-105, -72),
    color: [rand(0.72, 0.92), rand(0.88, 1), 1],
  }));
}

function makeConstellations() {
  const patterns = [
    [[-16, 44, -88], [-10, 49, -90], [-4, 44, -89], [3, 50, -91], [10, 44, -88], [0, 39, -89], [-16, 44, -88]],
    [[26, 50, -93], [31, 45, -91], [39, 48, -94], [31, 45, -91], [31, 36, -90], [24, 30, -91], [31, 36, -90], [40, 31, -92]],
    [[-48, 36, -84], [-40, 39, -85], [-30, 42, -87], [-20, 46, -88], [-28, 37, -86], [-20, 46, -88], [-18, 35, -87]],
  ];
  return patterns;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = 1.5;
}

function showWaveAnnouncement() {
  waveBanner.textContent = `Wave ${state.wave}`;
  waveFlash.classList.remove("show");
  waveBanner.classList.remove("show");
  void waveFlash.offsetWidth;
  waveFlash.classList.add("show");
  waveBanner.classList.add("show");
  playSound("wave");
}

function spawnWave() {
  state.waveDestroyed = 0;
  state.waveTotal = 0;
  const count = 4 + Math.ceil(state.wave * 1.55);
  for (let i = 0; i < count; i += 1) {
    const type = Math.random() < Math.min(0.23 + state.wave * 0.04, 0.54) ? "raider" : "scout";
    state.enemies.push({
      type,
      x: rand(-34, 34),
      z: rand(-30, 2),
      y: type === "raider" ? rand(7.5, 11) : rand(10, 15),
      vx: type === "raider" ? rand(-5.5, 5.5) : rand(-4, 4),
      vz: type === "raider" ? rand(-2.3, 3.4) : rand(-1.4, 2.4),
      phase: rand(0, Math.PI * 2),
      cooldown: type === "raider" ? rand(0.9, 2.2) : rand(1.15, 2.9),
      health: type === "raider" ? 3 : 2,
      radius: type === "raider" ? 2.8 : 2.35,
    });
    state.waveTotal += 1;
  }

  if (state.wave % 3 === 0) {
    state.enemies.push({
      type: "mothership",
      x: 0,
      z: -26,
      y: 16,
      vx: 3.2 + state.wave * 0.18,
      vz: 1.1,
      phase: 0,
      cooldown: 1,
      health: 16 + state.wave * 2,
      radius: 5.6,
    });
    state.waveTotal += 1;
  }

  showToast(`Wave ${state.wave} incoming`);
  showWaveAnnouncement();
}

function updateHud() {
  state.bestScore = Math.max(state.bestScore, state.score);
  scoreEl.textContent = String(state.score);
  bestScoreEl.textContent = String(state.bestScore);
  waveEl.textContent = String(state.wave);
  destroyedEl.textContent = `${state.waveDestroyed}/${state.waveTotal}`;
  accuracyEl.textContent = `${state.shots ? Math.round((state.hits / state.shots) * 100) : 0}%`;
  healthBar.style.transform = `scaleX(${clamp(state.health, 0, 100) / 100})`;
}

function updatePointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = (event.clientX - rect.left) / rect.width;
  pointer.y = (event.clientY - rect.top) / rect.height;
  pointer.worldX = clamp(state.tank.x + (pointer.x - 0.5) * 74, -WORLD_LIMIT, WORLD_LIMIT);
  pointer.worldZ = clamp(state.tank.z - 34 + (pointer.y - 0.5) * 72, -WORLD_LIMIT, WORLD_LIMIT);
}

function getAimTarget() {
  if (state.target && !state.target.dead && state.enemies.includes(state.target)) {
    return { x: state.target.x, y: state.target.y, z: state.target.z, enemy: state.target };
  }
  return { x: pointer.worldX, y: 8.5, z: pointer.worldZ, enemy: null };
}

function tankGroundY(x = state.tank.x, z = state.tank.z) {
  const angle = state.tank.bodyAngle;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const samples = [
    [0, 0],
    [-2.4, -3],
    [2.4, -3],
    [-2.4, 3],
    [2.4, 3],
    [0, -3.4],
    [0, 3.4],
  ];
  let highest = -Infinity;
  for (const [sx, sz] of samples) {
    const wx = x + sx * c + sz * s;
    const wz = z - sx * s + sz * c;
    highest = Math.max(highest, terrainHeight(wx, wz));
  }
  return highest - 0.25 + 0.55;
}

function cycleTarget() {
  if (!running || state.enemies.length === 0) {
    state.target = null;
    showToast("No UFO target");
    return;
  }

  const sorted = [...state.enemies].sort((a, b) => {
    const da = Math.hypot(a.x - state.tank.x, a.z - state.tank.z);
    const db = Math.hypot(b.x - state.tank.x, b.z - state.tank.z);
    return da - db;
  });
  const currentIndex = sorted.indexOf(state.target);
  state.target = sorted[(currentIndex + 1) % sorted.length];
  showToast(`Target locked: ${state.target.type}`);
}

function clearTarget() {
  if (!state.target) return;
  state.target = null;
  showToast("Target cleared");
}

function fire() {
  if (!running || state.tank.cooldown > 0) return;
  const aim = getAimTarget();
  const startY = state.tank.y + 1.8;
  const dx = aim.x - state.tank.x;
  const dy = aim.y - startY;
  const dz = aim.z - state.tank.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const start = [
    state.tank.x + (dx / len) * 3.2,
    startY,
    state.tank.z + (dz / len) * 3.2,
  ];
  state.bullets.push({
    x: start[0],
    y: start[1],
    z: start[2],
    px: start[0],
    py: start[1],
    pz: start[2],
    vx: (dx / len) * 66,
    vy: (dy / len) * 66,
    vz: (dz / len) * 66,
    radius: 0.42,
    life: 1.45,
    maxLife: 1.45,
    dead: false,
  });
  state.tank.cooldown = 0.2;
  state.shots += 1;
  playSound("tankFire");
  spawnExplosion(start[0], start[1], start[2], [0.45, 1, 0.55], 6, 5);
  updateHud();
}

function spawnEnemyShot(enemy) {
  const dx = state.tank.x - enemy.x;
  const dz = state.tank.z - enemy.z;
  const dy = state.tank.y + 1.2 - enemy.y;
  const len = Math.hypot(dx, dy, dz) || 1;
  const start = [enemy.x, enemy.y - 1.1, enemy.z];
  const speed = enemy.type === "mothership" ? 34 : 29;
  state.enemyShots.push({
    x: start[0],
    y: start[1],
    z: start[2],
    px: start[0],
    py: start[1],
    pz: start[2],
    vx: (dx / len) * speed,
    vy: (dy / len) * speed,
    vz: (dz / len) * speed,
    radius: enemy.type === "mothership" ? 0.55 : 0.42,
    damage: enemy.type === "mothership" ? 10 : 6,
    life: 2.6,
    maxLife: 2.6,
    dead: false,
  });
  playSound("enemyFire");
}

function spawnExplosion(x, y, z, color, count, speed) {
  for (let i = 0; i < count; i += 1) {
    const a = rand(0, Math.PI * 2);
    state.explosions.push({
      x,
      y,
      z,
      vx: Math.cos(a) * rand(speed * 0.2, speed),
      vy: rand(2, speed * 1.4),
      vz: Math.sin(a) * rand(speed * 0.2, speed),
      color,
      size: rand(0.28, 0.95),
      life: rand(0.35, 0.9),
      maxLife: 0.9,
      shape: "spark",
    });
  }
}

function spawnVehicleExplosion(x, y, z, baseColor, scale = 1) {
  spawnExplosion(x, y, z, [1, 0.68, 0.18], Math.floor(34 * scale), 9 * scale);
  spawnExplosion(x, y + 0.5 * scale, z, baseColor, Math.floor(24 * scale), 7.2 * scale);
  for (let i = 0; i < 16 * scale; i += 1) {
    const a = rand(0, Math.PI * 2);
    const lift = rand(2.6, 9.5) * scale;
    state.explosions.push({
      x: x + rand(-0.7, 0.7) * scale,
      y: y + rand(-0.2, 0.9) * scale,
      z: z + rand(-0.7, 0.7) * scale,
      vx: Math.cos(a) * rand(3.5, 11) * scale,
      vy: lift,
      vz: Math.sin(a) * rand(3.5, 11) * scale,
      yaw: rand(0, Math.PI * 2),
      spin: rand(-8, 8),
      color: i % 3 === 0 ? [0.08, 0.1, 0.11] : baseColor,
      size: rand(0.32, 0.92) * scale,
      life: rand(1.0, 1.8),
      maxLife: 1.8,
      shape: i % 4 === 0 ? "panel" : "chunk",
    });
  }
  state.explosions.push({
    x,
    y: y - 0.08,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    spin: 0,
    color: [1, 0.72, 0.22],
    size: 1.6 * scale,
    life: 0.55,
    maxLife: 0.55,
    shape: "shockwave",
  });
}

function damageTank(amount) {
  if (state.tank.destroyed) return;
  state.health -= amount;
  state.shake = Math.max(state.shake, 1.1);
  playSound("damage");
  spawnExplosion(state.tank.x, state.tank.y + 1.3, state.tank.z, [1, 0.25, 0.32], 24, 8);
  if (state.health <= 0) {
    state.tank.destroyed = true;
    state.shake = Math.max(state.shake, 2.4);
    playSound("explosion");
    spawnVehicleExplosion(state.tank.x, state.tank.y + 1.1, state.tank.z, [0.14, 0.43, 0.38], 1.45);
    endGame();
  }
  updateHud();
}

function damageShrub(shrub, color) {
  if (!shrub || shrub.dead) return;
  shrub.hp -= 1;
  const y = terrainHeight(shrub.x, shrub.z) + shrub.scale * 1.3;
  playSound(shrub.hp <= 0 ? "explosion" : "hit");
  spawnExplosion(shrub.x, y, shrub.z, color, 16, 5.5);
  if (shrub.hp <= 0) {
    shrub.dead = true;
    shrub.regrowTimer = shrub.regrowDuration;
    spawnExplosion(shrub.x, y, shrub.z, [1, 0.55, 0.18], 18, 6);
  }
}

function updateShrubs(dt) {
  for (const shrub of state.shrubs) {
    if (!shrub.dead) continue;
    shrub.regrowTimer -= dt;
    if (shrub.regrowTimer > 0) continue;
    shrub.dead = false;
    shrub.hp = shrub.maxHp;
    shrub.regrowDuration = rand(20, 34);
    const y = terrainHeight(shrub.x, shrub.z) + shrub.scale * 1.4;
    playSound("regrow");
    spawnExplosion(shrub.x, y, shrub.z, [0.32, 0.9, 0.28], 14, 4.8);
  }
}

function tankHitsTree(x, z) {
  return state.shrubs.some((shrub) => {
    if (shrub.dead) return false;
    const radius = 2.55 + shrub.radius * shrub.scale;
    return Math.hypot(x - shrub.x, z - shrub.z) < radius;
  });
}

function nearestTreeHit(start, end) {
  let nearest = null;
  for (const shrub of state.shrubs) {
    if (shrub.dead) continue;
    const point = [
      shrub.x,
      terrainHeight(shrub.x, shrub.z) + shrub.scale * (shrub.kind === "bush" ? 0.8 : 2.0),
      shrub.z,
    ];
    const hit = nearestPointOnSegmentDistance(start, end, point);
    const radius = shrub.radius * shrub.scale + 0.6;
    if (hit.distance > radius) continue;
    const distance = hit.t * segmentLength(start, end);
    if (!nearest || distance < nearest.distance) nearest = { shrub, point: hit.point, distance };
  }
  return nearest;
}

function nearestEnemyHit(start, end) {
  let nearest = null;
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    const hit = nearestPointOnSegmentDistance(start, end, [enemy.x, enemy.y, enemy.z]);
    if (hit.distance > enemy.radius + 0.8) continue;
    const distance = hit.t * segmentLength(start, end);
    if (!nearest || distance < nearest.distance) nearest = { enemy, point: hit.point, distance };
  }
  return nearest;
}

function nearestPointOnSegmentDistance(start, end, point) {
  const ax = start[0], ay = start[1], az = start[2];
  const bx = end[0], by = end[1], bz = end[2];
  const px = point[0], py = point[1], pz = point[2];
  const vx = bx - ax, vy = by - ay, vz = bz - az;
  const wx = px - ax, wy = py - ay, wz = pz - az;
  const lenSq = vx * vx + vy * vy + vz * vz || 1;
  const t = clamp((wx * vx + wy * vy + wz * vz) / lenSq, 0, 1);
  const closest = [ax + vx * t, ay + vy * t, az + vz * t];
  return {
    t,
    point: closest,
    distance: Math.hypot(px - closest[0], py - closest[1], pz - closest[2]),
  };
}

function segmentLength(start, end) {
  return Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
}

function endGame() {
  running = false;
  saveStats();
  overlay.querySelector("h1").textContent = "Mission Failed";
  overlay.querySelector("p:not(.kicker)").textContent =
    `Final score: ${state.score}. Best: ${state.bestScore}. UFOs destroyed: ${state.destroyed}.`;
  startButton.textContent = "Retry Mission";
  overlay.classList.remove("hidden");
}

function update(dt) {
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) toast.classList.remove("show");
  }
  updateCamera(dt);
  if (!running) {
    updateExplosions(dt);
    return;
  }
  updateTank(dt);
  updateBullets(dt);
  updateEnemies(dt);
  updateEnemyShots(dt);
  updateShrubs(dt);
  updatePickups(dt);
  updateExplosions(dt);
  if (state.enemies.length === 0) {
    state.wave += 1;
    state.health = clamp(state.health + 7, 0, 100);
    spawnWave();
  }
  state.shake = Math.max(0, state.shake - dt * 3);
  updateHud();
}

function updateCamera(dt) {
  const shake = state.shake ? rand(-state.shake, state.shake) : 0;
  camera.x = lerp(camera.x, state.tank.x + shake, Math.min(1, dt * 4.5));
  camera.y = lerp(camera.y, 24 + shake * 0.4, Math.min(1, dt * 4.5));
  camera.z = lerp(camera.z, state.tank.z + 37 + shake, Math.min(1, dt * 4.5));
  camera.tx = lerp(camera.tx, state.tank.x, Math.min(1, dt * 4.5));
  camera.ty = lerp(camera.ty, state.tank.y + 2.0, Math.min(1, dt * 4.5));
  camera.tz = lerp(camera.tz, state.tank.z - 13, Math.min(1, dt * 4.5));
}

function updateTank(dt) {
  const forward = Number(keys.has("KeyW") || keys.has("ArrowUp")) - Number(keys.has("KeyS") || keys.has("ArrowDown"));
  const strafe = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const inputX = clamp(strafe + touchMove.x, -1, 1);
  const inputZ = clamp(forward + touchMove.z, -1, 1);
  const len = Math.hypot(inputX, inputZ) || 1;
  const targetVx = (inputX / len) * 24;
  const targetVz = (-inputZ / len) * 24;
  state.tank.vx = lerp(state.tank.vx, targetVx, Math.min(1, dt * 8));
  state.tank.vz = lerp(state.tank.vz, targetVz, Math.min(1, dt * 8));
  const currentHeight = tankGroundY();
  const nextX = clamp(state.tank.x + state.tank.vx * dt, -WORLD_LIMIT, WORLD_LIMIT);
  const nextZ = clamp(state.tank.z + state.tank.vz * dt, -WORLD_LIMIT, WORLD_LIMIT);
  const nextHeight = tankGroundY(nextX, nextZ);
  const slope = nextHeight - currentHeight;
  const slopeFactor = clamp(1 - Math.max(0, slope) * 0.18 + Math.max(0, -slope) * 0.06, 0.58, 1.08);
  const proposedX = clamp(state.tank.x + state.tank.vx * dt * slopeFactor, -WORLD_LIMIT, WORLD_LIMIT);
  const proposedZ = clamp(state.tank.z + state.tank.vz * dt * slopeFactor, -WORLD_LIMIT, WORLD_LIMIT);
  if (tankHitsTree(proposedX, proposedZ)) {
    state.tank.vx *= -0.18;
    state.tank.vz *= -0.18;
    state.shake = Math.max(state.shake, 0.18);
  } else {
    state.tank.x = proposedX;
    state.tank.z = proposedZ;
  }
  state.tank.y = lerp(state.tank.y, tankGroundY(), Math.min(1, dt * 14));
  if (Math.hypot(state.tank.vx, state.tank.vz) > 1) state.tank.bodyAngle = Math.atan2(state.tank.vx, state.tank.vz);
  const aim = getAimTarget();
  state.tank.turretAngle = Math.atan2(aim.x - state.tank.x, aim.z - state.tank.z);
  state.tank.cooldown = Math.max(0, state.tank.cooldown - dt);
  if (pointer.down || keys.has("Space")) fire();
}

function updateBullets(dt) {
  for (const bullet of state.bullets) {
    bullet.px = bullet.x;
    bullet.py = bullet.y;
    bullet.pz = bullet.z;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.z += bullet.vz * dt;
    bullet.life -= dt;

    const start = [bullet.px, bullet.py, bullet.pz];
    const end = [bullet.x, bullet.y, bullet.z];
    const treeHit = nearestTreeHit(start, end);
    const enemyHit = nearestEnemyHit(start, end);
    const treeDistance = treeHit ? treeHit.distance : Infinity;
    const enemyDistance = enemyHit ? enemyHit.distance : Infinity;
    if (treeDistance < enemyDistance) {
      bullet.dead = true;
      damageShrub(treeHit.shrub, [0.15, 1, 0.28]);
      spawnExplosion(treeHit.point[0], treeHit.point[1], treeHit.point[2], [0.45, 1, 0.55], 8, 5.5);
    } else if (enemyHit) {
      bullet.dead = true;
      enemyHit.enemy.health -= 1;
      state.hits += 1;
      state.score += 18;
      playSound("hit");
      spawnExplosion(enemyHit.point[0], enemyHit.point[1], enemyHit.point[2], enemyHit.enemy.type === "raider" ? [1, 0.38, 0.58] : [0.45, 1, 0.86], 12, 7);
      if (enemyHit.enemy.health <= 0) destroyEnemy(enemyHit.enemy);
    }
  }
  state.bullets = state.bullets.filter((bullet) => bullet.life > 0 && !bullet.dead && Math.abs(bullet.x) < WORLD_LIMIT + 18 && Math.abs(bullet.z) < WORLD_LIMIT + 18);
}

function destroyEnemy(enemy) {
  enemy.dead = true;
  if (state.target === enemy) state.target = null;
  state.score += enemy.type === "mothership" ? 650 : enemy.type === "raider" ? 145 : 105;
  state.destroyed += 1;
  state.waveDestroyed += 1;
  state.shake = Math.max(state.shake, enemy.type === "mothership" ? 1.5 : 0.85);
  playSound("explosion");
  spawnExplosion(enemy.x, enemy.y, enemy.z, [1, 0.75, 0.28], enemy.type === "mothership" ? 70 : 32, enemy.type === "mothership" ? 12 : 8);
  spawnVehicleExplosion(
    enemy.x,
    enemy.y,
    enemy.z,
    enemy.type === "raider" ? [0.78, 0.25, 0.38] : enemy.type === "mothership" ? [0.96, 0.82, 0.38] : [0.6, 0.86, 0.95],
    enemy.type === "mothership" ? 2.1 : enemy.type === "raider" ? 1.18 : 1,
  );
  if (Math.random() < 0.22) state.pickups.push({ x: enemy.x, y: 1.1, z: enemy.z, phase: rand(0, Math.PI * 2), dead: false });
}

function updateEnemies(dt) {
  for (const enemy of state.enemies) {
    enemy.phase += dt * (enemy.type === "mothership" ? 1.5 : enemy.type === "raider" ? 4.2 : 3.1);
    const dx = state.tank.x - enemy.x;
    const dz = state.tank.z - enemy.z;
    const dist = Math.hypot(dx, dz) || 1;
    if (enemy.type === "raider") {
      const chase = dist > 15 ? 5.2 : -2.2;
      enemy.vx += (dx / dist) * dt * chase;
      enemy.vz += (dz / dist) * dt * chase;
      enemy.vx += (dz / dist) * Math.sin(enemy.phase * 1.35) * dt * 4.4;
      enemy.vz -= (dx / dist) * Math.sin(enemy.phase * 1.35) * dt * 4.4;
    } else if (dist < 26) {
      enemy.vx -= (dx / dist) * dt * 2.4;
      enemy.vz -= (dz / dist) * dt * 2.4;
    }
    enemy.vx += Math.sin(enemy.phase * 0.7) * dt * (enemy.type === "raider" ? 2.6 : 1.9);
    enemy.vz += Math.cos(enemy.phase * 0.9) * dt * (enemy.type === "raider" ? 1.8 : 1.25);
    const maxSpeed = enemy.type === "raider" ? 11.2 : 6.2;
    const speed = Math.hypot(enemy.vx, enemy.vz);
    if (speed > maxSpeed) {
      enemy.vx = (enemy.vx / speed) * maxSpeed;
      enemy.vz = (enemy.vz / speed) * maxSpeed;
    }
    enemy.x += enemy.vx * dt;
    enemy.z += enemy.vz * dt;
    enemy.y += Math.sin(enemy.phase) * dt * 1.2;
    if (Math.abs(enemy.x) > WORLD_LIMIT - 5) enemy.vx *= -1;
    if (enemy.z < -WORLD_LIMIT + 5 || enemy.z > WORLD_LIMIT - 14) enemy.vz *= -1;
    enemy.cooldown -= dt;
    if (enemy.cooldown <= 0) {
      spawnEnemyShot(enemy);
      enemy.cooldown = (enemy.type === "raider" ? rand(1.0, 2.15) : rand(1.35, 2.95)) / (1 + state.wave * 0.035);
    }
  }
  state.enemies = state.enemies.filter((enemy) => !enemy.dead);
  if (state.target && !state.enemies.includes(state.target)) state.target = null;
}

function updateEnemyShots(dt) {
  for (const shot of state.enemyShots) {
    shot.px = shot.x;
    shot.py = shot.y;
    shot.pz = shot.z;
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    shot.z += shot.vz * dt;
    shot.life -= dt;

    const start = [shot.px, shot.py, shot.pz];
    const end = [shot.x, shot.y, shot.z];
    const treeHit = nearestTreeHit(start, end);
    const tankHit = nearestPointOnSegmentDistance(start, end, [state.tank.x, state.tank.y + 1.1, state.tank.z]);
    const treeDistance = treeHit ? treeHit.distance : Infinity;
    const tankDistance = tankHit.distance < 2.7 + shot.radius ? tankHit.t * segmentLength(start, end) : Infinity;
    if (treeDistance < tankDistance) {
      shot.dead = true;
      damageShrub(treeHit.shrub, [1, 0.12, 0.08]);
      spawnExplosion(treeHit.point[0], treeHit.point[1], treeHit.point[2], [1, 0.18, 0.08], 8, 5);
    } else if (tankDistance < Infinity) {
      shot.dead = true;
      damageTank(shot.damage);
    }
  }
  state.enemyShots = state.enemyShots.filter((shot) => shot.life > 0 && !shot.dead && Math.abs(shot.x) < WORLD_LIMIT + 18 && Math.abs(shot.z) < WORLD_LIMIT + 18);
}

function updatePickups(dt) {
  for (const pickup of state.pickups) {
    pickup.phase += dt * 4;
    pickup.y = 1.1 + Math.sin(pickup.phase) * 0.3;
    if (Math.hypot(pickup.x - state.tank.x, pickup.z - state.tank.z) < 3.8) {
      pickup.dead = true;
      state.health = clamp(state.health + 18, 0, 100);
      state.score += 70;
      playSound("pickup");
      spawnExplosion(pickup.x, 2, pickup.z, [0.45, 1, 0.86], 20, 7);
    }
  }
  state.pickups = state.pickups.filter((pickup) => !pickup.dead);
}

function updateExplosions(dt) {
  for (const spark of state.explosions) {
    spark.x += spark.vx * dt;
    spark.y += spark.vy * dt;
    spark.z += spark.vz * dt;
    spark.vy -= 10 * dt;
    spark.yaw = (spark.yaw || 0) + (spark.spin || 0) * dt;
    spark.life -= dt;
  }
  state.explosions = state.explosions.filter((spark) => spark.life > 0);
}

function render() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const projection = perspective(Math.PI / 3.1, canvas.width / canvas.height, 0.1, 220);
  const view = lookAt([camera.x, camera.y, camera.z], [camera.tx, camera.ty, camera.tz], [0, 1, 0]);
  gl.uniformMatrix4fv(loc.view, false, view);
  gl.uniformMatrix4fv(loc.projection, false, projection);

  drawSkyMeshes();
  drawMesh(meshes.terrain, matrix([0, -0.25, 0], 0, [1, 1, 1]));

  for (const rock of state.rocks) drawRock(rock);
  for (const shrub of state.shrubs) drawShrub(shrub);
  for (const pickup of state.pickups) drawPickup(pickup);
  if (!state.tank.destroyed) drawTank();
  for (const enemy of state.enemies) drawUfo(enemy);
  if (state.target && !state.target.dead) drawTargetLock(state.target);
  for (const bullet of state.bullets) drawProjectile(bullet, [0.2, 1, 0.36], 0.56);
  for (const shot of state.enemyShots) drawProjectile(shot, [1, 0.18, 0.08], 0.48);
  for (const spark of state.explosions) {
    const alphaScale = clamp(spark.life / spark.maxLife, 0.25, 1);
    drawExplosionPart(spark, alphaScale);
  }
}

function drawExplosionPart(spark, alphaScale) {
  if (spark.shape === "panel") {
    drawMesh(meshes.cube, matrix([spark.x, spark.y, spark.z], spark.yaw || 0, [spark.size * 1.5 * alphaScale, spark.size * 0.16 * alphaScale, spark.size * 0.72 * alphaScale]), spark.color);
  } else if (spark.shape === "chunk") {
    drawMesh(meshes.cube, matrix([spark.x, spark.y, spark.z], spark.yaw || 0, [spark.size * alphaScale, spark.size * 0.62 * alphaScale, spark.size * 0.86 * alphaScale]), spark.color);
  } else if (spark.shape === "shockwave") {
    const grow = 1 - clamp(spark.life / spark.maxLife, 0, 1);
    drawMesh(meshes.cylinder, matrix([spark.x, spark.y, spark.z], 0, [spark.size * (1.2 + grow * 4.4), 0.045 * alphaScale, spark.size * (1.2 + grow * 4.4)]), [spark.color[0] * alphaScale, spark.color[1] * alphaScale, spark.color[2] * alphaScale]);
  } else {
    drawMesh(meshes.sphere, matrix([spark.x, spark.y, spark.z], 0, [spark.size * alphaScale, spark.size * alphaScale, spark.size * alphaScale]), spark.color);
  }
}

function drawSkyMeshes() {
  gl.disable(gl.DEPTH_TEST);
  drawMesh(meshes.stars, matrix([camera.x, 0, camera.z + 12], 0, [1, 1, 1]), null, 4 * pixelRatio);
  drawMesh(meshes.constellationLines, matrix([camera.x, 0, camera.z + 12], 0, [1, 1, 1]), null, 1);
  gl.enable(gl.DEPTH_TEST);
}

function drawTank() {
  const tank = state.tank;
  const y = tank.y;
  const c = Math.cos(tank.bodyAngle);
  const s = Math.sin(tank.bodyAngle);
  const f = [Math.sin(tank.bodyAngle), Math.cos(tank.bodyAngle)];
  const r = [Math.cos(tank.bodyAngle), -Math.sin(tank.bodyAngle)];
  drawMesh(meshes.cube, matrix([tank.x, y + 0.66, tank.z], tank.bodyAngle, [4.7, 0.9, 5.5]), [0.14, 0.43, 0.38]);
  drawMesh(meshes.cube, matrix([tank.x, y + 1.14, tank.z - c * 0.18], tank.bodyAngle, [3.25, 0.58, 3.6]), [0.22, 0.57, 0.5]);
  drawMesh(meshes.cube, matrix([tank.x, y + 1.5, tank.z - c * 0.62], tank.bodyAngle, [2.0, 0.32, 1.55]), [0.12, 0.34, 0.32]);
  drawMesh(meshes.cube, matrix([tank.x + f[0] * 2.88, y + 0.96, tank.z + f[1] * 2.88], tank.bodyAngle, [3.55, 0.26, 0.32]), [0.09, 0.28, 0.25]);
  drawMesh(meshes.cube, matrix([tank.x - f[0] * 2.6, y + 0.98, tank.z - f[1] * 2.6], tank.bodyAngle, [3.0, 0.3, 0.42]), [0.08, 0.24, 0.22]);
  drawMesh(meshes.cube, matrix([tank.x + f[0] * 1.2, y + 1.42, tank.z + f[1] * 1.2], tank.bodyAngle, [2.75, 0.08, 0.22]), [0.73, 0.94, 0.86]);
  drawMesh(meshes.cube, matrix([tank.x - f[0] * 0.85, y + 1.42, tank.z - f[1] * 0.85], tank.bodyAngle, [1.85, 0.08, 0.2]), [0.08, 0.21, 0.2]);
  for (let i = -1; i <= 1; i += 1) {
    drawMesh(meshes.cube, matrix([tank.x + r[0] * i * 0.86 - f[0] * 1.52, y + 1.63, tank.z + r[1] * i * 0.86 - f[1] * 1.52], tank.bodyAngle, [0.46, 0.16, 0.4]), [0.18, 0.46, 0.41]);
  }
  drawMesh(meshes.cube, matrix([tank.x - c * 2.36, y + 0.42, tank.z + s * 2.36], tank.bodyAngle, [0.78, 0.58, 5.9]), [0.04, 0.055, 0.065]);
  drawMesh(meshes.cube, matrix([tank.x + c * 2.36, y + 0.42, tank.z - s * 2.36], tank.bodyAngle, [0.78, 0.58, 5.9]), [0.04, 0.055, 0.065]);
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i += 1) {
      const wx = tank.x + c * side * 2.38 + s * i * 1.08;
      const wz = tank.z - s * side * 2.38 + c * i * 1.08;
      drawMesh(meshes.cylinder, matrix([wx, y + 0.43, wz], tank.bodyAngle + Math.PI / 2, [0.33, 0.18, 0.33]), [0.1, 0.12, 0.12]);
    }
    drawMesh(meshes.cube, matrix([tank.x + r[0] * side * 2.48, y + 0.74, tank.z + r[1] * side * 2.48], tank.bodyAngle, [0.18, 0.2, 5.2]), [0.22, 0.31, 0.28]);
  }
  drawMesh(meshes.cylinder, matrix([tank.x, y + 1.58, tank.z], tank.turretAngle, [1.45, 0.78, 1.45]), [0.31, 0.66, 0.59]);
  drawMesh(meshes.sphere, matrix([tank.x, y + 1.92, tank.z], 0, [0.78, 0.42, 0.78]), [0.48, 0.88, 0.76]);
  const bx = tank.x + Math.sin(tank.turretAngle) * 2.2;
  const bz = tank.z + Math.cos(tank.turretAngle) * 2.2;
  drawMesh(meshes.cube, matrix([bx, y + 1.68, bz], tank.turretAngle, [0.34, 0.34, 4.55]), [0.72, 0.84, 0.84]);
  drawMesh(meshes.cube, matrix([tank.x + Math.sin(tank.turretAngle) * 4.55, y + 1.68, tank.z + Math.cos(tank.turretAngle) * 4.55], tank.turretAngle, [0.52, 0.52, 0.32]), [0.1, 0.16, 0.16]);
  drawMesh(meshes.cylinder, matrix([tank.x - Math.sin(tank.bodyAngle) * 1.15, y + 2.32, tank.z - Math.cos(tank.bodyAngle) * 1.15], tank.bodyAngle, [0.06, 1.15, 0.06]), [0.1, 0.18, 0.16]);
  drawMesh(meshes.sphere, matrix([tank.x - Math.sin(tank.bodyAngle) * 1.15, y + 2.96, tank.z - Math.cos(tank.bodyAngle) * 1.15], 0, [0.13, 0.13, 0.13]), [0.75, 1, 0.7]);
  drawMesh(meshes.sphere, matrix([tank.x + Math.sin(tank.bodyAngle) * 0.92, y + 1.92, tank.z + Math.cos(tank.bodyAngle) * 0.92], 0, [0.28, 0.28, 0.28]), [0.72, 1, 0.9]);
  for (const side of [-1, 1]) {
    drawMesh(meshes.sphere, matrix([tank.x + r[0] * side * 1.35 + f[0] * 2.46, y + 1.08, tank.z + r[1] * side * 1.35 + f[1] * 2.46], 0, [0.2, 0.16, 0.2]), [0.9, 1, 0.76]);
    drawMesh(meshes.cylinder, matrix([tank.x + r[0] * side * 1.72 - f[0] * 2.45, y + 1.18, tank.z + r[1] * side * 1.72 - f[1] * 2.45], tank.bodyAngle, [0.14, 0.42, 0.14]), [0.12, 0.12, 0.11]);
    for (const front of [-1, 1]) {
      drawMesh(meshes.sphere, matrix([tank.x + r[0] * side * 2.08 + f[0] * front * 1.72, y + 1.02, tank.z + r[1] * side * 2.08 + f[1] * front * 1.72], 0, [0.11, 0.11, 0.11]), [0.04, 0.07, 0.065]);
    }
  }
}

function drawUfo(enemy) {
  const scale = enemy.type === "mothership" ? 2.25 : enemy.type === "raider" ? 1.25 : 1;
  const color = enemy.type === "raider" ? [0.78, 0.25, 0.38] : [0.6, 0.86, 0.95];
  const glow = enemy.type === "raider" ? [1, 0.12, 0.1] : [0.2, 1, 0.78];
  drawMesh(meshes.sphere, matrix([enemy.x, enemy.y, enemy.z], enemy.phase, [2.4 * scale, 0.42 * scale, 2.4 * scale]), color);
  drawMesh(meshes.sphere, matrix([enemy.x, enemy.y + 0.42 * scale, enemy.z], enemy.phase, [1.05 * scale, 0.55 * scale, 1.05 * scale]), enemy.type === "mothership" ? [0.96, 0.82, 0.38] : [0.86, 0.98, 1]);
  drawMesh(meshes.sphere, matrix([enemy.x, enemy.y + 0.78 * scale, enemy.z], enemy.phase, [0.54 * scale, 0.22 * scale, 0.54 * scale]), [0.92, 1, 1]);
  drawMesh(meshes.cylinder, matrix([enemy.x, enemy.y - 0.25 * scale, enemy.z], enemy.phase, [2.55 * scale, 0.14 * scale, 2.55 * scale]), enemy.type === "raider" ? [1, 0.35, 0.48] : [0.42, 1, 0.82]);
  drawMesh(meshes.cylinder, matrix([enemy.x, enemy.y - 0.02 * scale, enemy.z], enemy.phase, [2.95 * scale, 0.08 * scale, 2.95 * scale]), [0.18, 0.22, 0.28]);
  drawMesh(meshes.cylinder, matrix([enemy.x, enemy.y + 0.24 * scale, enemy.z], enemy.phase, [1.48 * scale, 0.08 * scale, 1.48 * scale]), [0.12, 0.18, 0.24]);
  for (let i = 0; i < 6; i += 1) {
    const a = enemy.phase + (i / 6) * Math.PI * 2;
    const sx = enemy.x + Math.cos(a) * 1.58 * scale;
    const sz = enemy.z + Math.sin(a) * 1.58 * scale;
    drawMesh(meshes.cube, matrix([sx, enemy.y - 0.11 * scale, sz], -a + Math.PI / 2, [0.16 * scale, 0.12 * scale, 1.35 * scale]), [0.48, 0.58, 0.62]);
  }
  for (let i = 0; i < 12; i += 1) {
    const a = enemy.phase + (i / 12) * Math.PI * 2;
    const tx = enemy.x + Math.cos(a) * 2.55 * scale;
    const tz = enemy.z + Math.sin(a) * 2.55 * scale;
    drawMesh(meshes.cube, matrix([tx, enemy.y - 0.08 * scale, tz], -a + Math.PI / 2, [0.08 * scale, 0.12 * scale, 0.42 * scale]), i % 2 ? [0.28, 0.34, 0.38] : [0.62, 0.72, 0.76]);
  }
  for (let i = 0; i < 8; i += 1) {
    const a = enemy.phase + (i / 8) * Math.PI * 2;
    const lx = enemy.x + Math.cos(a) * 2.12 * scale;
    const lz = enemy.z + Math.sin(a) * 2.12 * scale;
    const light = i % 2 ? glow : [1, 0.9, 0.34];
    drawMesh(meshes.sphere, matrix([lx, enemy.y + 0.05 * scale, lz], 0, [0.16 * scale, 0.16 * scale, 0.16 * scale]), light);
  }
  drawMesh(meshes.cube, matrix([enemy.x, enemy.y - 0.62 * scale, enemy.z], enemy.phase, [0.38 * scale, 0.34 * scale, 0.38 * scale]), enemy.type === "raider" ? [1, 0.25, 0.28] : [0.52, 1, 0.78]);
  for (let i = 0; i < 4; i += 1) {
    const a = enemy.phase + Math.PI / 4 + (i / 4) * Math.PI * 2;
    drawMesh(meshes.sphere, matrix([enemy.x + Math.cos(a) * 2.62 * scale, enemy.y - 0.36 * scale, enemy.z + Math.sin(a) * 2.62 * scale], 0, [0.22 * scale, 0.18 * scale, 0.22 * scale]), [0.9, 0.96, 1]);
  }
  if (enemy.type === "raider") {
    for (const wing of [-1, 1]) {
      drawMesh(meshes.cube, matrix([enemy.x + Math.cos(enemy.phase) * wing * 2.75 * scale, enemy.y + 0.12 * scale, enemy.z + Math.sin(enemy.phase) * wing * 2.75 * scale], enemy.phase + Math.PI / 2, [0.2 * scale, 0.08 * scale, 1.0 * scale]), [1, 0.22, 0.16]);
    }
  }
}

function drawTargetLock(enemy) {
  const scale = enemy.type === "mothership" ? 2.25 : enemy.type === "raider" ? 1.25 : 1;
  const pulse = 1 + Math.sin(performance.now() * 0.01) * 0.08;
  const color = [1, 0.95, 0.28];
  drawMesh(meshes.cube, matrix([enemy.x, enemy.y + 0.05, enemy.z], enemy.phase, [5.4 * scale * pulse, 0.08, 0.18]), color);
  drawMesh(meshes.cube, matrix([enemy.x, enemy.y + 0.05, enemy.z], enemy.phase + Math.PI / 2, [5.4 * scale * pulse, 0.08, 0.18]), color);
  drawMesh(meshes.cube, matrix([enemy.x, enemy.y + 2.1 * scale, enemy.z], enemy.phase, [1.2 * scale, 0.08, 0.18]), color);
}

function drawShrub(shrub) {
  const trunk = [0.36, 0.23, 0.14];
  const green = [0.24 + shrub.colorShift, 0.5 + shrub.colorShift, 0.27 + shrub.colorShift];
  const ground = terrainHeight(shrub.x, shrub.z) - 0.25;
  if (shrub.dead) {
    const progress = clamp(1 - shrub.regrowTimer / shrub.regrowDuration, 0, 1);
    drawMesh(meshes.cylinder, matrix([shrub.x, ground + 0.2 * shrub.scale, shrub.z], shrub.lean, [0.3 * shrub.scale, 0.42 * shrub.scale, 0.3 * shrub.scale]), [0.29, 0.17, 0.1]);
    if (progress > 0.18) {
      const sproutScale = shrub.scale * lerp(0.16, 0.68, progress);
      const sproutY = ground + 0.45 * shrub.scale + progress * 0.74 * shrub.scale;
      drawMesh(meshes.cylinder, matrix([shrub.x, ground + 0.55 * shrub.scale, shrub.z], shrub.lean, [0.09 * shrub.scale, 0.78 * shrub.scale * progress, 0.09 * shrub.scale]), trunk);
      if (shrub.kind === "pine") {
        drawMesh(meshes.cone, matrix([shrub.x, sproutY, shrub.z], shrub.lean, [0.72 * sproutScale, 1.1 * sproutScale, 0.72 * sproutScale]), green);
      } else {
        drawMesh(meshes.sphere, matrix([shrub.x, sproutY, shrub.z], 0, [0.72 * sproutScale, 0.56 * sproutScale, 0.72 * sproutScale]), green);
      }
    }
    return;
  }
  drawMesh(meshes.cylinder, matrix([shrub.x, ground + 0.78 * shrub.scale, shrub.z], shrub.lean, [0.22 * shrub.scale, 1.35 * shrub.scale, 0.22 * shrub.scale]), trunk);
  if (shrub.kind === "pine") {
    drawMesh(meshes.cylinder, matrix([shrub.x, ground + 1.55 * shrub.scale, shrub.z], shrub.lean + 0.5, [0.08 * shrub.scale, 1.35 * shrub.scale, 0.08 * shrub.scale]), [0.25, 0.16, 0.1]);
    drawMesh(meshes.cylinder, matrix([shrub.x, ground + 1.95 * shrub.scale, shrub.z], shrub.lean - 0.42, [0.07 * shrub.scale, 1.1 * shrub.scale, 0.07 * shrub.scale]), [0.25, 0.16, 0.1]);
    drawMesh(meshes.cone, matrix([shrub.x, ground + 1.85 * shrub.scale, shrub.z], shrub.lean, [1.05 * shrub.scale, 1.55 * shrub.scale, 1.05 * shrub.scale]), green);
    drawMesh(meshes.cone, matrix([shrub.x, ground + 2.65 * shrub.scale, shrub.z], shrub.lean, [0.78 * shrub.scale, 1.35 * shrub.scale, 0.78 * shrub.scale]), [green[0] * 0.9, green[1] * 0.95, green[2] * 0.9]);
    drawMesh(meshes.cone, matrix([shrub.x, ground + 3.35 * shrub.scale, shrub.z], shrub.lean, [0.52 * shrub.scale, 1.0 * shrub.scale, 0.52 * shrub.scale]), [green[0] * 0.82, green[1] * 0.9, green[2] * 0.82]);
  } else if (shrub.kind === "tree") {
    drawMesh(meshes.sphere, matrix([shrub.x, ground + 2.35 * shrub.scale, shrub.z], 0, [1.15 * shrub.scale, 0.95 * shrub.scale, 1.15 * shrub.scale]), green);
    drawMesh(meshes.sphere, matrix([shrub.x + 0.62 * shrub.scale, ground + 2.15 * shrub.scale, shrub.z - 0.24 * shrub.scale], 0, [0.78 * shrub.scale, 0.7 * shrub.scale, 0.78 * shrub.scale]), [green[0] * 0.92, green[1] * 1.04, green[2] * 0.92]);
    drawMesh(meshes.sphere, matrix([shrub.x - 0.55 * shrub.scale, ground + 2.04 * shrub.scale, shrub.z + 0.36 * shrub.scale], 0, [0.7 * shrub.scale, 0.62 * shrub.scale, 0.7 * shrub.scale]), [green[0] * 0.82, green[1] * 0.96, green[2] * 0.82]);
  } else {
    drawMesh(meshes.sphere, matrix([shrub.x, ground + 0.72 * shrub.scale, shrub.z], 0, [1.05 * shrub.scale, 0.48 * shrub.scale, 1.05 * shrub.scale]), [0.39 + shrub.colorShift, 0.56 + shrub.colorShift, 0.26 + shrub.colorShift]);
    drawMesh(meshes.sphere, matrix([shrub.x + 0.55 * shrub.scale, ground + 0.62 * shrub.scale, shrub.z - 0.32 * shrub.scale], 0, [0.58 * shrub.scale, 0.32 * shrub.scale, 0.58 * shrub.scale]), [0.3 + shrub.colorShift, 0.5 + shrub.colorShift, 0.22 + shrub.colorShift]);
    drawMesh(meshes.sphere, matrix([shrub.x - 0.46 * shrub.scale, ground + 0.58 * shrub.scale, shrub.z + 0.42 * shrub.scale], 0, [0.52 * shrub.scale, 0.28 * shrub.scale, 0.52 * shrub.scale]), [0.43 + shrub.colorShift, 0.6 + shrub.colorShift, 0.28 + shrub.colorShift]);
  }
}

function drawRock(rock) {
  const ground = terrainHeight(rock.x, rock.z) - 0.22;
  const base = [0.32 + rock.tint, 0.3 + rock.tint, 0.27 + rock.tint];
  drawMesh(meshes.sphere, matrix([rock.x, ground + 0.28 * rock.scale, rock.z], rock.yaw, [0.82 * rock.scale, 0.36 * rock.scale, 0.62 * rock.scale]), base);
  drawMesh(meshes.sphere, matrix([rock.x + Math.cos(rock.yaw) * 0.54 * rock.scale, ground + 0.2 * rock.scale, rock.z + Math.sin(rock.yaw) * 0.54 * rock.scale], rock.yaw, [0.46 * rock.scale, 0.24 * rock.scale, 0.42 * rock.scale]), [base[0] * 0.86, base[1] * 0.86, base[2] * 0.86]);
}

function drawProjectile(projectile, color, size) {
  const lifeScale = clamp(projectile.life / projectile.maxLife, 0.25, 1);
  const core = size * lifeScale;
  const trailStart = [
    projectile.x - projectile.vx * 0.035,
    projectile.y - projectile.vy * 0.035,
    projectile.z - projectile.vz * 0.035,
  ];
  const trailEnd = [projectile.x, projectile.y, projectile.z];
  drawMesh(meshes.cube, segmentMatrix(trailStart, trailEnd, core * 0.28), [color[0] * 0.42, color[1] * 0.42, color[2] * 0.42]);
  drawMesh(meshes.sphere, matrix([projectile.x, projectile.y, projectile.z], 0, [core * 1.65, core * 1.65, core * 1.65]), [color[0] * 0.22, color[1] * 0.22, color[2] * 0.22]);
  drawMesh(meshes.sphere, matrix([projectile.x, projectile.y, projectile.z], 0, [core, core, core]), color);
}

function drawPickup(pickup) {
  drawMesh(meshes.cube, matrix([pickup.x, pickup.y, pickup.z], pickup.phase, [0.8, 0.8, 0.8]), [0.45, 1, 0.86]);
}

function loop(time) {
  const dt = Math.min(0.033, (time - lastTime) / 1000 || 0);
  lastTime = time;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
  canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}

function startMission() {
  ensureAudio();
  resetWorld();
  running = true;
  overlay.classList.add("hidden");
  canvas.focus();
}

startButton.addEventListener("click", startMission);
overlay.addEventListener("pointerdown", (event) => {
  if (event.target === startButton || overlay.classList.contains("hidden")) return;
  startMission();
});
window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (!running && (event.code === "Enter" || event.code === "Space")) startMission();
  if (running && (event.code === "KeyQ" || event.code === "Tab")) cycleTarget();
  if (running && event.code === "Escape") clearTarget();
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(event.code)) event.preventDefault();
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 250));
canvas.addEventListener("pointermove", updatePointer);
canvas.addEventListener("pointerdown", (event) => {
  updatePointer(event);
  pointer.down = true;
  fire();
});
window.addEventListener("pointerup", () => {
  pointer.down = false;
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener(
  "touchmove",
  (event) => {
    if (running) event.preventDefault();
  },
  { passive: false },
);

moveStick.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  touchMove.active = true;
  touchMove.pointerId = event.pointerId;
  moveStick.setPointerCapture(event.pointerId);
  updateMoveStick(event);
});

moveStick.addEventListener("pointermove", (event) => {
  if (!touchMove.active || event.pointerId !== touchMove.pointerId) return;
  event.preventDefault();
  updateMoveStick(event);
});

function releaseMoveStick(event) {
  if (event.pointerId !== touchMove.pointerId) return;
  touchMove.active = false;
  touchMove.pointerId = null;
  touchMove.x = 0;
  touchMove.z = 0;
  moveKnob.style.transform = "translate(-50%, -50%)";
}

moveStick.addEventListener("pointerup", releaseMoveStick);
moveStick.addEventListener("pointercancel", releaseMoveStick);

touchFire.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  pointer.down = true;
  fire();
});

touchFire.addEventListener("pointerup", (event) => {
  event.preventDefault();
  pointer.down = false;
});

touchFire.addEventListener("pointercancel", () => {
  pointer.down = false;
});

touchLock.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  cycleTarget();
});

mobileControls.addEventListener("contextmenu", (event) => event.preventDefault());

function updateMoveStick(event) {
  const rect = moveStick.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const max = rect.width * 0.36;
  const dx = clamp(event.clientX - cx, -max, max);
  const dy = clamp(event.clientY - cy, -max, max);
  const length = Math.hypot(dx, dy);
  const limitedX = length > max ? (dx / length) * max : dx;
  const limitedY = length > max ? (dy / length) * max : dy;
  touchMove.x = clamp(limitedX / max, -1, 1);
  touchMove.z = clamp(-limitedY / max, -1, 1);
  moveKnob.style.transform = `translate(calc(-50% + ${limitedX}px), calc(-50% + ${limitedY}px))`;
}

function drawMesh(mesh, model, overrideColor, pointSize = 1) {
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
  gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(loc.position);
  gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 36, 12);
  gl.enableVertexAttribArray(loc.normal);
  gl.vertexAttribPointer(loc.color, 3, gl.FLOAT, false, 36, 24);
  gl.enableVertexAttribArray(loc.color);
  if (overrideColor) {
    if (!mesh.overrideBuffer) mesh.overrideBuffer = gl.createBuffer();
    const data = mesh.data.slice();
    for (let i = 0; i < data.length; i += 9) {
      data[i + 6] = overrideColor[0];
      data[i + 7] = overrideColor[1];
      data[i + 8] = overrideColor[2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.overrideBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 36, 0);
    gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 36, 12);
    gl.vertexAttribPointer(loc.color, 3, gl.FLOAT, false, 36, 24);
  }
  gl.uniformMatrix4fv(loc.model, false, model);
  gl.uniform1f(loc.pointSize, pointSize);
  gl.drawArrays(mesh.mode, 0, mesh.count);
}

function createMesh(data, mode) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return { buffer, count: data.length / 9, mode, data };
}

function createProgram(vertexSource, fragmentSource) {
  const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  const shaderProgram = gl.createProgram();
  gl.attachShader(shaderProgram, vertex);
  gl.attachShader(shaderProgram, fragment);
  gl.linkProgram(shaderProgram);
  if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(shaderProgram));
  return shaderProgram;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function vertex(out, position, normal, color) {
  out.push(position[0], position[1], position[2], normal[0], normal[1], normal[2], color[0], color[1], color[2]);
}

function boxGeometry() {
  const c = [1, 1, 1];
  const v = [];
  const faces = [
    [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [0, 0, 1]],
    [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0, 0, -1]],
    [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [0, 1, 0]],
    [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [0, -1, 0]],
    [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [1, 0, 0]],
    [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-1, 0, 0]],
  ];
  for (const face of faces) {
    const [a, b, c1, d, n] = face;
    vertex(v, a, n, c); vertex(v, b, n, c); vertex(v, c1, n, c);
    vertex(v, a, n, c); vertex(v, c1, n, c); vertex(v, d, n, c);
  }
  return new Float32Array(v);
}

function cylinderGeometry(segments) {
  const v = [];
  const color = [1, 1, 1];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const p1 = [Math.cos(a), -0.5, Math.sin(a)];
    const p2 = [Math.cos(b), -0.5, Math.sin(b)];
    const p3 = [Math.cos(b), 0.5, Math.sin(b)];
    const p4 = [Math.cos(a), 0.5, Math.sin(a)];
    const n1 = [Math.cos(a), 0, Math.sin(a)];
    const n2 = [Math.cos(b), 0, Math.sin(b)];
    vertex(v, p1, n1, color); vertex(v, p2, n2, color); vertex(v, p3, n2, color);
    vertex(v, p1, n1, color); vertex(v, p3, n2, color); vertex(v, p4, n1, color);
    vertex(v, [0, 0.5, 0], [0, 1, 0], color); vertex(v, p4, [0, 1, 0], color); vertex(v, p3, [0, 1, 0], color);
    vertex(v, [0, -0.5, 0], [0, -1, 0], color); vertex(v, p2, [0, -1, 0], color); vertex(v, p1, [0, -1, 0], color);
  }
  return new Float32Array(v);
}

function coneGeometry(segments) {
  const v = [];
  const color = [1, 1, 1];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const p1 = [Math.cos(a), -0.5, Math.sin(a)];
    const p2 = [Math.cos(b), -0.5, Math.sin(b)];
    const tip = [0, 0.5, 0];
    const n = normalize([Math.cos((a + b) / 2), 0.7, Math.sin((a + b) / 2)]);
    vertex(v, p1, n, color); vertex(v, p2, n, color); vertex(v, tip, n, color);
    vertex(v, [0, -0.5, 0], [0, -1, 0], color); vertex(v, p2, [0, -1, 0], color); vertex(v, p1, [0, -1, 0], color);
  }
  return new Float32Array(v);
}

function sphereGeometry(segments, rings) {
  const v = [];
  const color = [1, 1, 1];
  for (let y = 0; y < rings; y += 1) {
    const v0 = y / rings;
    const v1 = (y + 1) / rings;
    const t0 = v0 * Math.PI;
    const t1 = v1 * Math.PI;
    for (let x = 0; x < segments; x += 1) {
      const u0 = (x / segments) * Math.PI * 2;
      const u1 = ((x + 1) / segments) * Math.PI * 2;
      const p1 = spherePoint(u0, t0);
      const p2 = spherePoint(u1, t0);
      const p3 = spherePoint(u1, t1);
      const p4 = spherePoint(u0, t1);
      vertex(v, p1, p1, color); vertex(v, p2, p2, color); vertex(v, p3, p3, color);
      vertex(v, p1, p1, color); vertex(v, p3, p3, color); vertex(v, p4, p4, color);
    }
  }
  return new Float32Array(v);
}

function spherePoint(u, t) {
  return [Math.cos(u) * Math.sin(t), Math.cos(t), Math.sin(u) * Math.sin(t)];
}

function terrainGeometry() {
  const v = [];
  const step = 6;
  for (let x = -96; x < 96; x += step) {
    for (let z = -96; z < 96; z += step) {
      const p1 = [x, terrainHeight(x, z), z];
      const p2 = [x + step, terrainHeight(x + step, z), z];
      const p3 = [x + step, terrainHeight(x + step, z + step), z + step];
      const p4 = [x, terrainHeight(x, z + step), z + step];
      const n1 = triangleNormal(p1, p2, p3);
      const n2 = triangleNormal(p1, p3, p4);
      vertex(v, p1, n1, terrainColor(p1[1])); vertex(v, p2, n1, terrainColor(p2[1])); vertex(v, p3, n1, terrainColor(p3[1]));
      vertex(v, p1, n2, terrainColor(p1[1])); vertex(v, p3, n2, terrainColor(p3[1])); vertex(v, p4, n2, terrainColor(p4[1]));
    }
  }
  return new Float32Array(v);
}

function terrainColor(height) {
  const t = clamp((height + 4.2) / 10.5, 0, 1);
  return [
    lerp(0.34, 0.68, t),
    lerp(0.2, 0.45, t),
    lerp(0.11, 0.24, t),
  ];
}

function triangleNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return normalize(cross(ac, ab));
}

function terrainHeight(x, z) {
  const rolling = Math.sin(x * 0.071) * 1.45 + Math.cos(z * 0.085) * 1.32;
  const ridges = Math.sin((x + z) * 0.047) * 1.08 + Math.cos((x - z) * 0.074) * 0.72;
  const ripples = Math.sin(x * 0.18 + z * 0.08) * 0.22 + Math.cos(z * 0.16 - x * 0.05) * 0.18;
  const moundA = 3.7 * Math.exp(-((x + 34) ** 2 + (z + 18) ** 2) / 960);
  const moundB = 3.05 * Math.exp(-((x - 30) ** 2 + (z - 34) ** 2) / 820);
  const moundC = 1.45 * Math.exp(-((x + 4) ** 2 + (z - 48) ** 2) / 680);
  const basin = 1.55 * Math.exp(-((x - 4) ** 2 + (z + 2) ** 2) / 560);
  return rolling + ridges + ripples + moundA + moundB + moundC - basin;
}

function starGeometry(stars) {
  const v = [];
  for (const star of stars) vertex(v, [star.x, star.y, star.z], [0, 0, 0], star.color);
  return new Float32Array(v);
}

function constellationGeometry(patterns) {
  const v = [];
  const color = [0.46, 0.92, 1];
  for (const pattern of patterns) {
    for (let i = 0; i < pattern.length - 1; i += 1) {
      vertex(v, pattern[i], [0, 0, 0], color);
      vertex(v, pattern[i + 1], [0, 0, 0], color);
    }
  }
  return new Float32Array(v);
}

function matrix(position, yaw, scale) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return new Float32Array([
    c * scale[0], 0, -s * scale[0], 0,
    0, scale[1], 0, 0,
    s * scale[2], 0, c * scale[2], 0,
    position[0], position[1], position[2], 1,
  ]);
}

function segmentMatrix(start, end, thickness) {
  const fx = end[0] - start[0];
  const fy = end[1] - start[1];
  const fz = end[2] - start[2];
  const length = Math.hypot(fx, fy, fz) || 1;
  const forward = [fx / length, fy / length, fz / length];
  const helper = Math.abs(forward[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const right = normalize(cross(helper, forward));
  const up = cross(forward, right);
  const cx = (start[0] + end[0]) * 0.5;
  const cy = (start[1] + end[1]) * 0.5;
  const cz = (start[2] + end[2]) * 0.5;
  return new Float32Array([
    right[0] * thickness, right[1] * thickness, right[2] * thickness, 0,
    up[0] * thickness, up[1] * thickness, up[2] * thickness, 0,
    forward[0] * length, forward[1] * length, forward[2] * length, 0,
    cx, cy, cz, 1,
  ]);
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, center, up) {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

resize();
window.__ufoTankReady = true;
