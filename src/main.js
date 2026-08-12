import './style.css';
import Phaser from 'phaser';

import {
  BALL_RADIUS,
  BALL_SPACING,
  BALL_TYPES,
  GAME_HEIGHT,
  GAME_WIDTH,
  LEVELS,
  TRACK_CONTROL_POINTS,
  SampledPath,
  createSeededRandom
} from './game-logic.js';
import {
  PLAYER_SLOTS,
  PROJECTILE_SPAWN_DISTANCE,
  PROJECTILE_SPEED,
  SHOT_COOLDOWN_MS,
  SWAP_COOLDOWN_MS
} from './multiplayer-config.js';
import { NetworkClient } from './network-client.js';
import { SoundEngine } from './sound-engine.js';
import { ThreeAtmosphere } from './three-atmosphere.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE_POINTER_QUERY = window.matchMedia('(any-pointer: coarse)');
const MAX_RENDER_EXTRAPOLATION_MS = 120;
const PLAYER_SCALE = 0.68;

const ui = {
  score: document.getElementById('score'),
  ballsLeft: document.getElementById('balls-left'),
  level: document.getElementById('level'),
  levelName: document.getElementById('level-name'),
  combo: document.getElementById('combo'),
  comboStat: document.querySelector('.combo-stat'),
  dangerPanel: document.querySelector('.danger-panel'),
  dangerFill: document.getElementById('danger-fill'),
  dangerLabel: document.getElementById('danger-label'),
  playerRoster: document.getElementById('player-roster'),
  currentAmmo: document.getElementById('current-ammo'),
  nextAmmo: document.getElementById('next-ammo'),
  ammoPanel: document.querySelector('.ammo-panel'),
  swapBtn: document.getElementById('swap-btn'),
  mobileFireBtn: document.getElementById('mobile-fire-btn'),
  soundBtn: document.getElementById('sound-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  connectionChip: document.getElementById('connection-chip'),
  connectionText: document.getElementById('connection-text'),
  pingValue: document.getElementById('ping-value'),
  roomBadge: document.getElementById('room-badge'),
  roomBadgeCode: document.getElementById('room-badge-code'),
  toast: document.getElementById('toast'),
  overlay: document.getElementById('overlay'),
  lobbyView: document.getElementById('lobby-view'),
  roomView: document.getElementById('room-view'),
  stateView: document.getElementById('state-view'),
  playerName: document.getElementById('player-name'),
  createRoomBtn: document.getElementById('create-room-btn'),
  joinForm: document.getElementById('join-form'),
  joinRoomBtn: document.getElementById('join-room-btn'),
  roomCodeInput: document.getElementById('room-code-input'),
  lobbyError: document.getElementById('lobby-error'),
  copyRoomBtn: document.getElementById('copy-room-btn'),
  roomCodeDisplay: document.getElementById('room-code-display'),
  lobbyPlayerList: document.getElementById('lobby-player-list'),
  hostMessage: document.getElementById('host-message'),
  startRoomBtn: document.getElementById('start-room-btn'),
  leaveRoomBtn: document.getElementById('leave-room-btn'),
  stateKicker: document.getElementById('state-kicker'),
  stateTitle: document.getElementById('state-title'),
  stateText: document.getElementById('state-text'),
  statePlayerList: document.getElementById('state-player-list'),
  stateHostMessage: document.getElementById('state-host-message'),
  stateActionBtn: document.getElementById('state-action-btn'),
  stateSecondaryBtn: document.getElementById('state-secondary-btn'),
  stateLeaveBtn: document.getElementById('state-leave-btn')
};

const network = new NetworkClient();
const sound = new SoundEngine();
let activeGame = null;
let activeScene = null;
let latestSnapshot = null;
let toastTimer = null;
let currentOverlayKey = '';
let lastHudRosterKey = '';
let lastDangerBand = -1;

function colorToCss(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function setOrb(element, colorIndex) {
  if (element.dataset.color === String(colorIndex)) return;
  const type = BALL_TYPES[colorIndex] ?? BALL_TYPES[0];
  element.dataset.color = String(colorIndex);
  element.style.setProperty('--orb', colorToCss(type.color));
  element.style.setProperty('--orb-light', colorToCss(type.light));
}

function setText(element, value) {
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
}

function isTouchLikePointer(pointer) {
  const event = pointer?.event;
  return event?.pointerType === 'touch' ||
    pointer?.pointerType === 'touch' ||
    event?.type?.startsWith('touch') ||
    Boolean(event?.changedTouches?.length);
}

function pulseHaptics(duration = 10) {
  if (COARSE_POINTER_QUERY.matches) navigator.vibrate?.(duration);
}

function getRosterKey(snapshot) {
  return snapshot.players
    .map((player) => `${player.id}:${player.name}:${player.slot}:${player.connected ? 1 : 0}`)
    .join('|');
}

function showToast(message, duration = 1400) {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.remove('hidden');
  toastTimer = window.setTimeout(() => ui.toast.classList.add('hidden'), duration);
}

function setOverlayView(view) {
  ui.lobbyView.classList.toggle('hidden', view !== 'lobby');
  ui.roomView.classList.toggle('hidden', view !== 'room');
  ui.stateView.classList.toggle('hidden', view !== 'state');
  ui.overlay.classList.remove('hidden');
}

function hideOverlay() {
  ui.overlay.classList.add('hidden');
  activeGame?.canvas?.focus?.({ preventScroll: true });
}

function getPlayerAccent(slot) {
  return colorToCss(PLAYER_SLOTS[slot]?.accent ?? 0x77e0a2);
}

function renderPlayerSlots(container, snapshot) {
  container.replaceChildren();
  for (let slot = 0; slot < PLAYER_SLOTS.length; slot += 1) {
    const player = snapshot?.players.find((item) => item.slot === slot);
    const card = document.createElement('div');
    card.className = `lobby-slot${player ? '' : ' is-empty'}`;
    card.style.setProperty('--player-accent', getPlayerAccent(slot));
    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    const name = document.createElement('strong');
    name.textContent = player?.name ?? `Slot ${slot + 1}`;
    const status = document.createElement('small');
    if (!player) status.textContent = 'Menunggu pemain';
    else if (!player.connected) status.textContent = 'Menyambungkan ulang...';
    else if (player.id === snapshot.hostId) status.textContent = 'Host';
    else status.textContent = player.id === network.selfId ? 'Kamu' : 'Siap';
    card.append(dot, name, status);
    container.append(card);
  }
}

function renderHudRoster(snapshot) {
  ui.playerRoster.replaceChildren();
  for (const player of snapshot?.players ?? []) {
    const card = document.createElement('div');
    card.className = `roster-player${player.id === network.selfId ? ' is-self' : ''}${player.connected ? '' : ' is-offline'}`;
    card.style.setProperty('--player-accent', getPlayerAccent(player.slot));
    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = player.name;
    const tag = document.createElement('span');
    tag.className = 'roster-tag';
    tag.textContent = player.id === snapshot.hostId ? 'Host' : player.id === network.selfId ? 'Kamu' : '';
    card.append(dot, name, tag);
    ui.playerRoster.append(card);
  }
}

function updateAmmoUI(snapshot = latestSnapshot) {
  const self = snapshot?.players.find((player) => player.id === network.selfId);
  const enabled = Boolean(self?.connected && snapshot?.state === 'playing' && network.status === 'online');
  setOrb(ui.currentAmmo, self?.currentColor ?? 0);
  setOrb(ui.nextAmmo, self?.nextColor ?? 1);
  ui.swapBtn.disabled = !enabled;
  ui.mobileFireBtn.disabled = !enabled;
}

function updateSnapshotUI(snapshot) {
  setText(ui.score, snapshot.score.toLocaleString('id-ID'));
  setText(ui.ballsLeft, snapshot.chain.length);
  setText(ui.level, snapshot.levelIndex + 1);
  setText(ui.levelName, snapshot.levelName);
  setText(ui.combo, `x${snapshot.combo}`);
  ui.roomBadge.classList.remove('hidden');
  setText(ui.roomBadgeCode, snapshot.roomCode);
  const rosterKey = `${snapshot.hostId}:${network.selfId}:${getRosterKey(snapshot)}`;
  if (rosterKey !== lastHudRosterKey) {
    lastHudRosterKey = rosterKey;
    renderHudRoster(snapshot);
  }
  updateAmmoUI(snapshot);
  updateDanger(snapshot.headDistance / snapshot.pathLength);

  const isHost = snapshot.hostId === network.selfId;
  ui.pauseBtn.disabled = !isHost || !['playing', 'paused'].includes(snapshot.state);
  ui.pauseBtn.querySelector('span').textContent = snapshot.state === 'paused' ? 'GO' : 'II';
  ui.pauseBtn.title = isHost ? 'Jeda untuk semua pemain' : 'Hanya host yang dapat menjeda';
}

function updateDanger(ratio) {
  const safeRatio = Phaser.Math.Clamp(ratio || 0, 0, 1);
  ui.dangerFill.style.transform = `scaleX(${safeRatio.toFixed(4)})`;
  let label = 'Kuil aman';
  let band = 0;
  if (safeRatio >= 0.78) {
    label = 'Bahaya! Gerbang dekat';
    band = 2;
  } else if (safeRatio >= 0.55) {
    label = 'Rantai mendekat';
    band = 1;
  }
  if (band !== lastDangerBand) {
    lastDangerBand = band;
    setText(ui.dangerLabel, label);
    ui.dangerPanel.classList.toggle('is-warning', band === 1);
    ui.dangerPanel.classList.toggle('is-critical', band === 2);
  }
}

function showLobby(errorMessage = '') {
  latestSnapshot = null;
  currentOverlayKey = 'lobby';
  lastHudRosterKey = '';
  lastDangerBand = -1;
  setOverlayView('lobby');
  ui.roomBadge.classList.add('hidden');
  ui.playerRoster.replaceChildren();
  ui.pauseBtn.disabled = true;
  ui.lobbyError.textContent = errorMessage || (network.status === 'online' ? 'Server siap.' : 'Menghubungkan ke server...');
  ui.lobbyError.classList.toggle('is-error', Boolean(errorMessage));
  activeScene?.clearNetworkState();
}

function renderRoomLobby(snapshot) {
  setOverlayView('room');
  ui.roomCodeDisplay.textContent = snapshot.roomCode;
  renderPlayerSlots(ui.lobbyPlayerList, snapshot);
  const isHost = snapshot.hostId === network.selfId;
  const connectedCount = snapshot.players.filter((player) => player.connected).length;
  ui.startRoomBtn.classList.toggle('hidden', !isHost);
  ui.startRoomBtn.disabled = !isHost || connectedCount < 1;
  ui.startRoomBtn.textContent = `Mulai ${connectedCount} Pemain`;
  ui.hostMessage.textContent = isHost
    ? 'Kamu adalah host. Game dapat dimulai sekarang atau tunggu teman bergabung.'
    : 'Menunggu host memulai permainan.';
}

function renderStateOverlay(snapshot) {
  const isHost = snapshot.hostId === network.selfId;
  setOverlayView('state');
  renderPlayerSlots(ui.statePlayerList, snapshot);
  ui.stateActionBtn.classList.toggle('hidden', !isHost);
  ui.stateSecondaryBtn.classList.add('hidden');
  ui.stateActionBtn.dataset.action = '';
  ui.stateSecondaryBtn.dataset.action = '';

  if (snapshot.state === 'paused') {
    ui.stateKicker.textContent = snapshot.levelName;
    ui.stateTitle.textContent = 'Permainan Dijeda';
    ui.stateText.textContent = 'Simulasi berhenti untuk seluruh pemain. Posisi rantai dan semua tembakan tetap aman.';
    ui.stateActionBtn.textContent = 'Lanjutkan';
    ui.stateActionBtn.dataset.action = 'pause';
  } else if (snapshot.state === 'levelComplete') {
    ui.stateKicker.textContent = `Level ${snapshot.levelIndex + 1} selesai`;
    ui.stateTitle.textContent = 'Gerbang Dibersihkan';
    ui.stateText.textContent = `Tim berhasil menghancurkan rantai. Bersiap memasuki ${LEVELS[snapshot.levelIndex + 1].name}.`;
    ui.stateActionBtn.textContent = 'Level Berikutnya';
    ui.stateActionBtn.dataset.action = 'next';
  } else if (snapshot.state === 'lost') {
    ui.stateKicker.textContent = `Level ${snapshot.levelIndex + 1} belum selesai`;
    ui.stateTitle.textContent = 'Gerbang Terbuka';
    ui.stateText.textContent = 'Rantai mencapai jantung kuil. Skor checkpoint tetap tersimpan jika level ini dicoba lagi.';
    ui.stateActionBtn.textContent = 'Coba Lagi';
    ui.stateActionBtn.dataset.action = 'retry';
    ui.stateSecondaryBtn.classList.toggle('hidden', !isHost);
    ui.stateSecondaryBtn.textContent = 'Ulang Campaign';
    ui.stateSecondaryBtn.dataset.action = 'restart';
  } else if (snapshot.state === 'won') {
    ui.stateKicker.textContent = 'Kemenangan tim';
    ui.stateTitle.textContent = 'Kuil Terselamatkan';
    ui.stateText.textContent = `Semua gerbang aman. Skor akhir tim: ${snapshot.score.toLocaleString('id-ID')}.`;
    ui.stateActionBtn.textContent = 'Main Lagi';
    ui.stateActionBtn.dataset.action = 'restart';
  }
  ui.stateHostMessage.textContent = isHost
    ? 'Kamu adalah host dan mengontrol kelanjutan room.'
    : 'Menunggu keputusan host.';
}

function updateOverlayForSnapshot(snapshot) {
  const key = `${snapshot.roomCode}:${snapshot.state}:${snapshot.hostId}:${getRosterKey(snapshot)}`;
  if (key === currentOverlayKey) return;
  if (snapshot.state === 'playing') {
    currentOverlayKey = key;
    hideOverlay();
    return;
  }
  if (snapshot.state === 'lobby') renderRoomLobby(snapshot);
  else renderStateOverlay(snapshot);
  currentOverlayKey = key;
}

function updateConnectionStatus({ status }) {
  const labels = {
    connecting: 'Menghubungkan',
    reconnecting: 'Menyambung ulang',
    online: 'Online',
    offline: 'Offline'
  };
  ui.connectionText.textContent = labels[status] ?? status;
  ui.connectionChip.classList.toggle('is-connecting', ['connecting', 'reconnecting'].includes(status));
  ui.connectionChip.classList.toggle('is-offline', status === 'offline');
  ui.createRoomBtn.disabled = status !== 'online';
  ui.joinRoomBtn.disabled = status !== 'online';
  if (status === 'online' && !latestSnapshot) {
    ui.lobbyError.textContent = 'Server siap.';
    ui.lobbyError.classList.remove('is-error');
  }
  if (status === 'reconnecting' && network.roomCode) {
    currentOverlayKey = 'reconnecting';
    setOverlayView('state');
    ui.stateKicker.textContent = 'Koneksi terputus';
    ui.stateTitle.textContent = 'Menyambungkan Ulang';
    ui.stateText.textContent = 'Sesi kamu disimpan selama 15 detik. Client sedang mencoba kembali otomatis.';
    ui.statePlayerList.replaceChildren();
    ui.stateHostMessage.textContent = 'Jangan tutup halaman ini.';
    ui.stateActionBtn.classList.add('hidden');
    ui.stateSecondaryBtn.classList.add('hidden');
  }
  updateAmmoUI();
}

class BallActor {
  constructor(scene, id, color, distance) {
    this.id = id;
    this.color = color;
    this.displayDistance = distance;
    this.targetDistance = distance;
    this.sprite = scene.add.image(0, 0, `ball-${BALL_TYPES[color].key}`)
      .setDisplaySize(BALL_RADIUS * 2 + 10, BALL_RADIUS * 2 + 10)
      .setDepth(7);
  }

  destroy() { this.sprite.destroy(); }
}

class ProjectileActor {
  constructor(scene, data, predicted = false) {
    this.id = data.id;
    this.color = data.color;
    this.ownerId = data.ownerId;
    this.clientShotId = data.clientShotId;
    this.predicted = predicted;
    this.x = data.x;
    this.y = data.y;
    this.vx = data.vx;
    this.vy = data.vy;
    this.receivedAt = performance.now();
    this.createdAt = performance.now();
    this.sprite = scene.add.image(data.x, data.y, `ball-${BALL_TYPES[data.color].key}`)
      .setDisplaySize(38, 40)
      .setDepth(10);
  }

  setAuthoritativeState(data) {
    this.x = data.x;
    this.y = data.y;
    this.vx = data.vx;
    this.vy = data.vy;
    this.receivedAt = performance.now();
  }

  destroy() { this.sprite.destroy(); }
}

class ShooterActor {
  constructor(scene, player, isSelf) {
    this.scene = scene;
    this.playerId = player.id;
    this.slot = player.slot;
    this.position = PLAYER_SLOTS[player.slot];
    this.angle = player.aimAngle;
    this.targetAngle = player.aimAngle;
    this.container = scene.add.container(this.position.x, this.position.y).setDepth(8).setScale(PLAYER_SCALE);
    const accent = this.position.accent;
    const shadow = scene.add.ellipse(0, 39, 118, 38, 0x000000, 0.42);
    this.halo = scene.add.circle(0, 0, 61, accent, isSelf ? 0.11 : 0.045).setStrokeStyle(isSelf ? 4 : 2, accent, 0.72);

    this.turret = scene.add.container(0, 0);
    const barrelShadow = scene.add.rectangle(28, 4, 66, 24, 0x000000, 0.34).setOrigin(0, 0.5);
    const barrel = scene.add.rectangle(24, 0, 64, 22, 0x2f7d5a).setOrigin(0, 0.5).setStrokeStyle(3, accent, 0.9);
    const barrelInset = scene.add.rectangle(31, 0, 48, 7, 0x102c24, 0.9).setOrigin(0, 0.5);
    this.mouthBall = scene.add.image(60, 0, 'ball-coral').setDisplaySize(42, 44);
    this.turret.add([barrelShadow, barrel, barrelInset, this.mouthBall]);

    const rim = scene.add.circle(0, 0, 47, 0x1b4538).setStrokeStyle(5, accent, 0.92);
    const face = scene.add.ellipse(0, 3, 77, 67, 0x397e55).setStrokeStyle(3, 0x8bc77b, 0.55);
    const browLeft = scene.add.circle(-20, -24, 17, 0x498e62).setStrokeStyle(3, 0xb3d583, 0.45);
    const browRight = scene.add.circle(20, -24, 17, 0x498e62).setStrokeStyle(3, 0xb3d583, 0.45);
    const eyeLeft = scene.add.circle(-20, -24, 9, 0xf2edc2);
    const eyeRight = scene.add.circle(20, -24, 9, 0xf2edc2);
    this.pupilLeft = scene.add.circle(-20, -24, 4.2, 0x07130f);
    this.pupilRight = scene.add.circle(20, -24, 4.2, 0x07130f);
    const noseLeft = scene.add.circle(-8, 1, 3, 0x173f30, 0.85);
    const noseRight = scene.add.circle(8, 1, 3, 0x173f30, 0.85);
    const smile = scene.add.arc(0, 10, 21, 15, 165, 0, false, 0x173f30, 1);
    const jewel = scene.add.circle(0, 37, 7, accent).setStrokeStyle(2, 0x34230f, 1);
    this.container.add([
      shadow,
      this.halo,
      this.turret,
      rim,
      face,
      browLeft,
      browRight,
      eyeLeft,
      eyeRight,
      this.pupilLeft,
      this.pupilRight,
      noseLeft,
      noseRight,
      smile,
      jewel
    ]);

    const labelY = this.position.y + (player.slot < 2 ? -58 : 51);
    this.label = scene.add.text(this.position.x, labelY, '', {
      fontFamily: 'Trebuchet MS, sans-serif',
      fontSize: '9px',
      fontStyle: 'bold',
      color: isSelf ? '#fff0a8' : '#c5decf',
      backgroundColor: '#061713cc',
      padding: { x: 4, y: 2 },
      stroke: '#04130f',
      strokeThickness: 3
    }).setOrigin(0.5).setDepth(12);
    this.setPlayer(player, isSelf);
  }

  setPlayer(player, isSelf) {
    this.isSelf = isSelf;
    this.targetAngle = player.aimAngle;
    const color = player.currentColor ?? 0;
    if (this.currentColor !== color) {
      this.currentColor = color;
      this.mouthBall.setTexture(`ball-${BALL_TYPES[color].key}`);
    }
    const nameLimit = isSelf ? 6 : 10;
    const compactName = player.name.length > nameLimit
      ? `${player.name.slice(0, Math.max(1, nameLimit - 2))}..`
      : player.name;
    const label = `${compactName}${isSelf ? ' [KAMU]' : ''}`;
    if (this.label.text !== label) this.label.text = label;
    if (this.connected !== player.connected) {
      this.connected = player.connected;
      this.container.setAlpha(player.connected ? 1 : 0.34);
      this.label.setAlpha(player.connected ? 1 : 0.42);
    }
  }

  setLocalAngle(angle) {
    this.angle = angle;
    this.targetAngle = angle;
  }

  update(time, dt) {
    if (!this.isSelf) {
      const difference = Phaser.Math.Angle.Wrap(this.targetAngle - this.angle);
      this.angle += difference * (1 - Math.exp(-18 * dt));
    }
    this.turret.setRotation(this.angle);
    const lookX = Math.cos(this.angle) * 4;
    const lookY = Math.sin(this.angle) * 4;
    this.pupilLeft.setPosition(-20 + lookX, -24 + lookY);
    this.pupilRight.setPosition(20 + lookX, -24 + lookY);
    const pulse = REDUCED_MOTION ? 1 : 1 + Math.sin(time * 0.003 + this.slot) * 0.012;
    this.halo.setScale(pulse);
  }

  destroy() {
    this.container.destroy(true);
    this.label.destroy();
  }
}

class MultiplayerZumaScene extends Phaser.Scene {
  constructor() {
    super('multiplayer-zuma');
  }

  create() {
    activeScene = this;
    this.path = new SampledPath(TRACK_CONTROL_POINTS, 30);
    this.ballActors = new Map();
    this.projectileActors = new Map();
    this.predictedProjectiles = new Map();
    this.shooterActors = new Map();
    this.snapshot = null;
    this.snapshotReceivedAt = 0;
    this.localAimAngle = -Math.PI / 2;
    this.localShotCounter = 0;
    this.nextLocalShotAt = 0;
    this.nextLocalSwapAt = 0;
    this.roomCode = null;

    this.createBallTextures();
    this.drawWorld();
    this.aimGraphics = this.add.graphics().setDepth(6);
    this.aimCursor = this.add.circle(650, 280, 11, 0x000000, 0).setStrokeStyle(2, 0xffe9a8, 0.58).setDepth(12).setVisible(false);
    this.bindInput();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
  }

  createBallTextures() {
    BALL_TYPES.forEach((type) => {
      const key = `ball-${type.key}`;
      if (this.textures.exists(key)) return;
      const graphics = this.make.graphics({ x: 0, y: 0, add: false });
      graphics.fillStyle(0x000000, 0.36).fillCircle(26, 29, 20);
      graphics.fillStyle(type.dark, 1).fillCircle(24, 24, 21);
      graphics.lineStyle(2, type.light, 0.62).strokeCircle(24, 24, 19);
      graphics.fillStyle(type.color, 1).fillCircle(24, 23, 17);
      graphics.fillStyle(type.light, 0.55).fillCircle(19, 18, 10);
      graphics.fillStyle(0xffffff, 0.9).fillCircle(17, 15, 4);
      graphics.fillStyle(0xffffff, 0.42).fillCircle(21, 13, 2);
      graphics.lineStyle(2, type.dark, 0.42);
      graphics.beginPath().arc(25, 25, 14, 0.2, 1.6).strokePath();
      graphics.generateTexture(key, 50, 52);
      graphics.destroy();
    });
  }

  drawWorld() {
    const backdrop = this.add.graphics().setDepth(0);
    backdrop.fillStyle(0x071713, 0.18).fillRoundedRect(36, 48, GAME_WIDTH - 72, GAME_HEIGHT - 90, 42);
    backdrop.lineStyle(2, 0xa77d3b, 0.08).strokeRoundedRect(36, 48, GAME_WIDTH - 72, GAME_HEIGHT - 90, 42);
    const random = createSeededRandom(7724);
    for (let index = 0; index < 130; index += 1) {
      backdrop.fillStyle(random() > 0.78 ? 0xe0b75a : 0x76cfa0, 0.035 + random() * 0.07);
      backdrop.fillCircle(random() * GAME_WIDTH, 70 + random() * (GAME_HEIGHT - 120), 0.5 + random() * 2.2);
    }

    const track = this.add.graphics().setDepth(2);
    this.strokePath(track, 61, 0x000000, 0.36);
    this.strokePath(track, 54, 0x17241f, 1);
    this.strokePath(track, 47, 0x73583b, 0.95);
    this.strokePath(track, 39, 0x293a30, 1);
    this.strokePath(track, 31, 0x172a25, 1);
    this.strokePath(track, 3, 0xb99450, 0.17);
    for (let distance = 22; distance < this.path.length - 25; distance += 56) {
      const point = this.path.getPointAtDistance(distance);
      const tangent = this.path.getTangentAtDistance(distance);
      const normal = { x: -tangent.y, y: tangent.x };
      track.fillStyle(0xd0ad61, 0.14);
      track.fillCircle(point.x + normal.x * 18, point.y + normal.y * 18, 2.2);
      track.fillCircle(point.x - normal.x * 18, point.y - normal.y * 18, 2.2);
      track.lineStyle(1, 0xb99b5a, 0.1);
      track.lineBetween(point.x + normal.x * 12, point.y + normal.y * 12, point.x - normal.x * 12, point.y - normal.y * 12);
    }
    this.drawEntrance();
    this.drawPortal();
    this.add.circle(650, 395, 96, 0x0d2b23, 0.42).setStrokeStyle(3, 0xbd9147, 0.22).setDepth(4);
    this.add.circle(650, 395, 73, 0x071914, 0.56).setStrokeStyle(1, 0x77e0a2, 0.13).setDepth(4);
  }

  strokePath(graphics, width, color, alpha) {
    graphics.lineStyle(width, color, alpha).beginPath();
    graphics.moveTo(this.path.points[0].x, this.path.points[0].y);
    for (let index = 1; index < this.path.points.length; index += 1) {
      graphics.lineTo(this.path.points[index].x, this.path.points[index].y);
    }
    graphics.strokePath();
  }

  drawEntrance() {
    const point = this.path.getPointAtDistance(112);
    const gate = this.add.container(point.x, point.y).setDepth(4).setRotation(-0.17);
    gate.add([
      this.add.ellipse(0, 20, 96, 34, 0x000000, 0.34),
      this.add.rectangle(-35, 0, 25, 92, 0x253b31).setStrokeStyle(3, 0x9b7541, 0.5),
      this.add.rectangle(35, 0, 25, 92, 0x253b31).setStrokeStyle(3, 0x9b7541, 0.5),
      this.add.rectangle(0, -43, 93, 20, 0x30493b).setStrokeStyle(3, 0xc2964a, 0.5),
      this.add.circle(0, -43, 8, 0x6ed99a, 0.75).setStrokeStyle(2, 0xf2cf73, 0.55)
    ]);
  }

  drawPortal() {
    const point = this.path.getPointAtDistance(this.path.length);
    this.portalGlow = this.add.circle(point.x, point.y, 53, 0xffb445, 0.07).setDepth(3);
    this.add.circle(point.x, point.y, 39, 0x10231f, 1).setStrokeStyle(8, 0x9a7040, 1).setDepth(4);
    this.add.circle(point.x, point.y, 29, 0x020b0a, 1).setStrokeStyle(2, 0xe1b65e, 0.32).setDepth(4);
    const skull = this.add.graphics().setDepth(5);
    skull.fillStyle(0xb8ae88, 1).fillCircle(point.x, point.y - 4, 20).fillRoundedRect(point.x - 13, point.y + 9, 26, 18, 5);
    skull.fillStyle(0x17211d, 1).fillEllipse(point.x - 8, point.y - 7, 9, 12).fillEllipse(point.x + 8, point.y - 7, 9, 12);
    skull.fillTriangle(point.x, point.y - 1, point.x - 4, point.y + 6, point.x + 4, point.y + 6);
    skull.lineStyle(2, 0x5b5544, 1);
    for (let x = -8; x <= 8; x += 8) skull.lineBetween(point.x + x, point.y + 12, point.x + x, point.y + 23);
    if (!REDUCED_MOTION) {
      this.tweens.add({ targets: this.portalGlow, scale: 1.2, alpha: 0.15, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    }
  }

  bindInput() {
    this.onPointerMove = (pointer) => {
      if (!isTouchLikePointer(pointer) || pointer.isDown) {
        this.updateLocalAim(pointer.worldX, pointer.worldY);
      }
    };
    this.onPointerDown = (pointer) => {
      if (pointer.rightButtonDown() || pointer.event?.button === 2) {
        this.swapAmmo();
        return;
      }
      this.updateLocalAim(pointer.worldX, pointer.worldY);
      if (!isTouchLikePointer(pointer)) this.fireProjectile();
    };
    this.input.on('pointermove', this.onPointerMove);
    this.input.on('pointerdown', this.onPointerDown);
    this.keys = this.input.keyboard.addKeys({
      swap: Phaser.Input.Keyboard.KeyCodes.SPACE,
      pause: Phaser.Input.Keyboard.KeyCodes.P,
      escape: Phaser.Input.Keyboard.KeyCodes.ESC
    });
    this.keys.swap.on('down', () => this.swapAmmo());
    this.keys.pause.on('down', () => this.requestPause());
    this.keys.escape.on('down', () => this.requestPause());
    this.preventContextMenu = (event) => event.preventDefault();
    this.preventCanvasTouch = (event) => event.preventDefault();
    this.game.canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.game.canvas.addEventListener('touchstart', this.preventCanvasTouch, { passive: false });
    this.game.canvas.addEventListener('touchmove', this.preventCanvasTouch, { passive: false });
  }

  cleanup() {
    if (activeScene === this) activeScene = null;
    this.game?.canvas?.removeEventListener('contextmenu', this.preventContextMenu);
    this.game?.canvas?.removeEventListener('touchstart', this.preventCanvasTouch);
    this.game?.canvas?.removeEventListener('touchmove', this.preventCanvasTouch);
  }

  applySnapshot(snapshot) {
    if (this.roomCode && this.roomCode !== snapshot.roomCode) this.clearNetworkState();
    const previousState = this.snapshot?.state;
    this.roomCode = snapshot.roomCode;
    this.snapshot = snapshot;
    this.snapshotReceivedAt = performance.now();
    this.syncBalls(snapshot);
    this.syncProjectiles(snapshot);
    this.syncShooters(snapshot);

    if (previousState !== snapshot.state) {
      if (snapshot.state === 'lost') {
        sound.lose();
        this.cameras.main.shake(420, REDUCED_MOTION ? 0 : 0.009);
        this.portalGlow.setFillStyle(0xff4238, 0.35).setScale(1.5);
      } else if (['levelComplete', 'won'].includes(snapshot.state)) {
        sound.win();
        this.portalGlow.setFillStyle(0xffb445, 0.07).setScale(1);
      } else if (snapshot.state === 'playing') {
        this.portalGlow.setFillStyle(0xffb445, 0.07).setScale(1);
      }
    }
  }

  syncBalls(snapshot) {
    const activeIds = new Set();
    snapshot.chain.forEach(([id, color], index) => {
      activeIds.add(id);
      const distance = snapshot.headDistance - index * BALL_SPACING;
      let actor = this.ballActors.get(id);
      if (!actor) {
        actor = new BallActor(this, id, color, distance);
        this.ballActors.set(id, actor);
      }
      actor.targetDistance = distance;
    });
    for (const [id, actor] of this.ballActors) {
      if (!activeIds.has(id)) {
        actor.destroy();
        this.ballActors.delete(id);
      }
    }
  }

  syncProjectiles(snapshot) {
    const activeIds = new Set();
    for (const projectile of snapshot.projectiles) {
      activeIds.add(projectile.id);
      let actor = this.projectileActors.get(projectile.id);
      if (!actor) {
        const predicted = this.predictedProjectiles.get(projectile.clientShotId);
        actor = new ProjectileActor(this, projectile, false);
        if (predicted) {
          actor.sprite.setPosition(predicted.sprite.x, predicted.sprite.y);
          predicted.destroy();
          this.predictedProjectiles.delete(projectile.clientShotId);
        }
        this.projectileActors.set(projectile.id, actor);
      }
      actor.setAuthoritativeState(projectile);
    }
    for (const [id, actor] of this.projectileActors) {
      if (!activeIds.has(id)) {
        actor.destroy();
        this.projectileActors.delete(id);
      }
    }
  }

  syncShooters(snapshot) {
    const activeIds = new Set(snapshot.players.map((player) => player.id));
    for (const player of snapshot.players) {
      let actor = this.shooterActors.get(player.id);
      if (!actor) {
        actor = new ShooterActor(this, player, player.id === network.selfId);
        this.shooterActors.set(player.id, actor);
      }
      const renderPlayer = player.id === network.selfId
        ? { ...player, aimAngle: this.localAimAngle }
        : player;
      actor.setPlayer(renderPlayer, player.id === network.selfId);
      if (player.id === network.selfId) actor.setLocalAngle(this.localAimAngle);
    }
    for (const [id, actor] of this.shooterActors) {
      if (!activeIds.has(id)) {
        actor.destroy();
        this.shooterActors.delete(id);
      }
    }
  }

  handleProjectileSpawn(event) {
    const projectile = event.projectile;
    if (this.projectileActors.has(projectile.id)) return;
    const predicted = this.predictedProjectiles.get(projectile.clientShotId);
    const actor = new ProjectileActor(this, projectile, false);
    if (predicted) {
      actor.sprite.setPosition(predicted.sprite.x, predicted.sprite.y);
      predicted.destroy();
      this.predictedProjectiles.delete(projectile.clientShotId);
    }
    this.projectileActors.set(projectile.id, actor);
  }

  handleImpact(event) {
    const actor = this.projectileActors.get(event.projectileId);
    actor?.destroy();
    this.projectileActors.delete(event.projectileId);
    const predicted = this.predictedProjectiles.get(event.clientShotId);
    predicted?.destroy();
    this.predictedProjectiles.delete(event.clientShotId);
    this.createImpactEffect(event.x, event.y, event.color);
    sound.impact();
  }

  handleMatch(event) {
    for (const removed of event.removed) {
      const actor = this.ballActors.get(removed.id);
      actor?.destroy();
      this.ballActors.delete(removed.id);
      this.burstBall(removed.x, removed.y, removed.color);
    }
    const focus = event.removed[Math.floor(event.removed.length / 2)];
    if (focus) this.showFloatingScore(focus.x, focus.y, event.gained, event.combo);
    sound.pop(event.combo);
    ui.comboStat.classList.add('is-hot');
    window.setTimeout(() => ui.comboStat.classList.remove('is-hot'), 250);
  }

  rejectShot(clientShotId) {
    const predicted = this.predictedProjectiles.get(clientShotId);
    predicted?.destroy();
    this.predictedProjectiles.delete(clientShotId);
  }

  getSelfPlayer() {
    return this.snapshot?.players.find((player) => player.id === network.selfId) ?? null;
  }

  canControl() {
    const self = this.getSelfPlayer();
    return Boolean(
      self?.connected &&
      this.snapshot?.state === 'playing' &&
      !this.snapshot.resolving &&
      network.status === 'online'
    );
  }

  updateLocalAim(x, y) {
    const self = this.getSelfPlayer();
    if (!self) return;
    const position = PLAYER_SLOTS[self.slot];
    const dx = x - position.x;
    const dy = y - position.y;
    if (dx * dx + dy * dy < 64) return;
    this.localAimAngle = Math.atan2(dy, dx);
    this.shooterActors.get(self.id)?.setLocalAngle(this.localAimAngle);
    this.aimCursor.setPosition(x, y).setVisible(this.snapshot?.state === 'playing');
    if (this.canControl()) network.sendAim(this.localAimAngle);
  }

  fireProjectile() {
    const now = performance.now();
    if (!this.canControl() || now < this.nextLocalShotAt) return;
    const self = this.getSelfPlayer();
    const position = PLAYER_SLOTS[self.slot];
    const direction = { x: Math.cos(this.localAimAngle), y: Math.sin(this.localAimAngle) };
    const clientShotId = `${network.selfId.slice(0, 8)}-${++this.localShotCounter}`;
    const data = {
      id: `pred-${clientShotId}`,
      ownerId: network.selfId,
      clientShotId,
      color: self.currentColor,
      x: position.x + direction.x * PROJECTILE_SPAWN_DISTANCE,
      y: position.y + direction.y * PROJECTILE_SPAWN_DISTANCE,
      vx: direction.x * PROJECTILE_SPEED,
      vy: direction.y * PROJECTILE_SPEED
    };
    const predicted = new ProjectileActor(this, data, true);
    this.predictedProjectiles.set(clientShotId, predicted);
    if (!network.fire(this.localAimAngle, clientShotId)) {
      predicted.destroy();
      this.predictedProjectiles.delete(clientShotId);
      return;
    }
    self.currentColor = self.nextColor;
    this.shooterActors.get(self.id)?.mouthBall.setTexture(`ball-${BALL_TYPES[self.currentColor].key}`);
    updateAmmoUI(this.snapshot);
    this.nextLocalShotAt = now + SHOT_COOLDOWN_MS;
    pulseHaptics(9);
    sound.unlock();
    sound.shoot();
  }

  swapAmmo() {
    const now = performance.now();
    if (!this.canControl() || now < this.nextLocalSwapAt) return;
    const self = this.getSelfPlayer();
    if (!network.swap()) return;
    [self.currentColor, self.nextColor] = [self.nextColor, self.currentColor];
    this.shooterActors.get(self.id)?.mouthBall.setTexture(`ball-${BALL_TYPES[self.currentColor].key}`);
    updateAmmoUI(this.snapshot);
    this.nextLocalSwapAt = now + SWAP_COOLDOWN_MS;
    ui.ammoPanel.classList.add('is-swapping');
    window.setTimeout(() => ui.ammoPanel.classList.remove('is-swapping'), 170);
    pulseHaptics(7);
    sound.swap();
  }

  requestPause() {
    if (this.snapshot?.hostId === network.selfId && ['playing', 'paused'].includes(this.snapshot.state)) {
      network.action('pause');
    }
  }

  update(time, delta) {
    const dt = Math.min(delta / 1000, 1 / 30);
    for (const shooter of this.shooterActors.values()) shooter.update(time, dt);
    this.updatePredictedProjectiles(dt);
    this.updateAuthoritativeProjectiles(dt);
    this.updateChain(dt);
    this.drawAimGuide();
  }

  getNetworkLeadMs() {
    const transitEstimate = Math.min(80, Math.max(0, (network.latency ?? 0) / 2));
    return Math.min(
      MAX_RENDER_EXTRAPOLATION_MS,
      Math.max(0, performance.now() - this.snapshotReceivedAt + transitEstimate)
    );
  }

  updateChain(dt) {
    if (!this.snapshot) return;
    const leadSeconds = this.snapshot.state === 'playing' ? this.getNetworkLeadMs() / 1000 : 0;
    const estimatedHead = this.snapshot.headDistance + this.snapshot.speed * leadSeconds;
    const interpolation = REDUCED_MOTION ? 1 : 1 - Math.exp(-14 * dt);
    this.snapshot.chain.forEach(([id], index) => {
      const actor = this.ballActors.get(id);
      if (!actor) return;
      actor.targetDistance = estimatedHead - index * BALL_SPACING;
      actor.displayDistance += (actor.targetDistance - actor.displayDistance) * interpolation;
      const point = this.path.getPointAtDistance(actor.displayDistance);
      actor.sprite.setPosition(point.x, point.y);
      actor.sprite.rotation += this.snapshot.speed / BALL_RADIUS * dt * 0.34;
      actor.sprite.setVisible(actor.displayDistance > -70 && actor.displayDistance < this.path.length + 50);
      actor.sprite.setAlpha(actor.displayDistance < 0 ? Phaser.Math.Clamp((actor.displayDistance + 70) / 70, 0, 1) : 1);
    });
    updateDanger(estimatedHead / this.snapshot.pathLength);
  }

  updateAuthoritativeProjectiles(dt) {
    const smoothing = REDUCED_MOTION ? 1 : 1 - Math.exp(-28 * dt);
    const leadSeconds = this.getNetworkLeadMs() / 1000;
    for (const actor of this.projectileActors.values()) {
      const targetX = actor.x + actor.vx * leadSeconds;
      const targetY = actor.y + actor.vy * leadSeconds;
      actor.sprite.x += (targetX - actor.sprite.x) * smoothing;
      actor.sprite.y += (targetY - actor.sprite.y) * smoothing;
      actor.sprite.rotation += dt * 7;
    }
  }

  updatePredictedProjectiles(dt) {
    const now = performance.now();
    for (const [shotId, actor] of this.predictedProjectiles) {
      actor.sprite.x += actor.vx * dt;
      actor.sprite.y += actor.vy * dt;
      actor.sprite.rotation += dt * 7;
      if (now - actor.createdAt > 1200) {
        actor.destroy();
        this.predictedProjectiles.delete(shotId);
      }
    }
  }

  drawAimGuide() {
    this.aimGraphics.clear();
    if (!this.canControl()) return;
    const self = this.getSelfPlayer();
    const position = PLAYER_SLOTS[self.slot];
    const directionX = Math.cos(this.localAimAngle);
    const directionY = Math.sin(this.localAimAngle);
    for (let distance = 62; distance < 280; distance += 25) {
      const alpha = 0.34 * (1 - (distance - 62) / 280);
      this.aimGraphics.lineStyle(2, position.accent, alpha).lineBetween(
        position.x + directionX * distance,
        position.y + directionY * distance,
        position.x + directionX * (distance + 10),
        position.y + directionY * (distance + 10)
      );
    }
  }

  createImpactEffect(x, y, color) {
    const ring = this.add.circle(x, y, 12, 0x000000, 0).setStrokeStyle(3, BALL_TYPES[color].light, 0.75).setDepth(12);
    this.tweens.add({ targets: ring, scale: 2.5, alpha: 0, duration: REDUCED_MOTION ? 80 : 260, onComplete: () => ring.destroy() });
  }

  burstBall(x, y, color) {
    const type = BALL_TYPES[color];
    const flash = this.add.circle(x, y, 18, type.light, 0.65).setDepth(12);
    this.tweens.add({ targets: flash, scale: 1.7, alpha: 0, duration: REDUCED_MOTION ? 80 : 210, onComplete: () => flash.destroy() });
    if (REDUCED_MOTION) return;
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * Math.PI * 2 + Math.random() * 0.3;
      const particle = this.add.circle(x, y, 2 + Math.random() * 3, index % 2 ? type.color : type.light, 0.9).setDepth(12);
      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * (24 + Math.random() * 22),
        y: y + Math.sin(angle) * (24 + Math.random() * 22),
        scale: 0.1,
        alpha: 0,
        duration: 260 + Math.random() * 160,
        onComplete: () => particle.destroy()
      });
    }
  }

  showFloatingScore(x, y, gained, combo) {
    const label = this.add.text(x, y - 12, `+${gained}${combo > 1 ? `  COMBO x${combo}` : ''}`, {
      fontFamily: 'Georgia, serif',
      fontSize: combo > 1 ? '20px' : '17px',
      fontStyle: 'bold',
      color: combo > 1 ? '#ffe28b' : '#dff7d8',
      stroke: '#092018',
      strokeThickness: 5
    }).setOrigin(0.5).setDepth(13);
    this.tweens.add({ targets: label, y: y - 58, alpha: 0, duration: REDUCED_MOTION ? 350 : 820, onComplete: () => label.destroy() });
  }

  clearNetworkState() {
    for (const actor of this.ballActors.values()) actor.destroy();
    for (const actor of this.projectileActors.values()) actor.destroy();
    for (const actor of this.predictedProjectiles.values()) actor.destroy();
    for (const actor of this.shooterActors.values()) actor.destroy();
    this.ballActors.clear();
    this.projectileActors.clear();
    this.predictedProjectiles.clear();
    this.shooterActors.clear();
    this.snapshot = null;
    this.roomCode = null;
    this.aimGraphics?.clear();
    this.aimCursor?.setVisible(false);
  }
}

ui.playerName.value = network.playerName || `Penjaga ${Math.floor(10 + Math.random() * 90)}`;
ui.roomCodeInput.addEventListener('input', () => {
  ui.roomCodeInput.value = ui.roomCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
});

ui.createRoomBtn.addEventListener('click', () => {
  sound.unlock();
  ui.lobbyError.textContent = 'Membuat room...';
  ui.lobbyError.classList.remove('is-error');
  network.createRoom(ui.playerName.value);
});

ui.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sound.unlock();
  if (ui.roomCodeInput.value.length !== 5) {
    ui.lobbyError.textContent = 'Masukkan kode room 5 karakter.';
    ui.lobbyError.classList.add('is-error');
    return;
  }
  ui.lobbyError.textContent = 'Bergabung ke room...';
  ui.lobbyError.classList.remove('is-error');
  network.joinRoom(ui.playerName.value, ui.roomCodeInput.value);
});

ui.copyRoomBtn.addEventListener('click', async () => {
  if (!network.roomCode) return;
  try {
    await navigator.clipboard.writeText(network.roomCode);
    showToast('Kode room disalin');
  } catch {
    showToast(`Kode room: ${network.roomCode}`, 2200);
  }
});

ui.startRoomBtn.addEventListener('click', () => network.action('start'));
ui.leaveRoomBtn.addEventListener('click', () => network.leaveRoom());
ui.stateLeaveBtn.addEventListener('click', () => network.leaveRoom());
ui.stateActionBtn.addEventListener('click', () => {
  if (ui.stateActionBtn.dataset.action) network.action(ui.stateActionBtn.dataset.action);
});
ui.stateSecondaryBtn.addEventListener('click', () => {
  if (ui.stateSecondaryBtn.dataset.action) network.action(ui.stateSecondaryBtn.dataset.action);
});

function bindQuickPress(element, handler) {
  element.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handler();
  });
  element.addEventListener('click', (event) => {
    if (event.detail === 0) handler();
    else event.preventDefault();
  });
}

bindQuickPress(ui.swapBtn, () => activeScene?.swapAmmo());
bindQuickPress(ui.mobileFireBtn, () => {
  sound.unlock();
  activeScene?.fireProjectile();
});
ui.pauseBtn.addEventListener('click', () => activeScene?.requestPause());
ui.soundBtn.addEventListener('click', () => {
  sound.setEnabled(!sound.enabled);
  ui.soundBtn.classList.toggle('is-muted', !sound.enabled);
  ui.soundBtn.querySelector('span').textContent = sound.enabled ? 'VOL' : 'OFF';
  ui.soundBtn.setAttribute('aria-label', sound.enabled ? 'Matikan suara' : 'Aktifkan suara');
  showToast(sound.enabled ? 'Suara aktif' : 'Suara dimatikan', 850);
});

network.on('status', updateConnectionStatus);
network.on('latency', ({ latency }) => {
  ui.pingValue.textContent = `${Math.round(latency)} ms`;
});
network.on('roomJoined', ({ roomCode, reconnected }) => {
  ui.roomCodeInput.value = roomCode;
  if (reconnected) showToast('Berhasil tersambung kembali');
});
network.on('roomLeft', () => showLobby());
network.on('snapshot', (snapshot) => {
  if (latestSnapshot && snapshot.roomCode === latestSnapshot.roomCode && snapshot.sequence <= latestSnapshot.sequence) return;
  latestSnapshot = snapshot;
  updateSnapshotUI(snapshot);
  updateOverlayForSnapshot(snapshot);
  activeScene?.applySnapshot(snapshot);
});
network.on('projectileSpawn', (event) => activeScene?.handleProjectileSpawn(event));
network.on('impact', (event) => activeScene?.handleImpact(event));
network.on('match', (event) => activeScene?.handleMatch(event));
network.on('shotRejected', (event) => activeScene?.rejectShot(event.clientShotId));
network.on('ammoChanged', (event) => {
  const player = latestSnapshot?.players.find((item) => item.id === event.playerId);
  if (!player) return;
  player.currentColor = event.currentColor;
  player.nextColor = event.nextColor;
  activeScene?.syncShooters(latestSnapshot);
  updateAmmoUI(latestSnapshot);
});
network.on('error', (error) => {
  const message = error.message || 'Terjadi kesalahan jaringan.';
  if (!latestSnapshot || latestSnapshot.state === 'lobby') {
    ui.lobbyError.textContent = message;
    ui.lobbyError.classList.add('is-error');
    if (!network.roomCode) setOverlayView('lobby');
  } else showToast(message, 2200);
});

function startClient() {
  const atmosphere = new ThreeAtmosphere(document.getElementById('three-layer'), REDUCED_MOTION);
  atmosphere.init();
  activeGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-layer',
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    transparent: true,
    backgroundColor: 'rgba(0,0,0,0)',
    antialias: true,
    banner: false,
    render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'high-performance' },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: GAME_WIDTH, height: GAME_HEIGHT },
    input: { activePointers: 3 },
    scene: [MultiplayerZumaScene]
  });
  showLobby();
  network.connect();
  window.addEventListener('beforeunload', () => {
    network.close();
    atmosphere.dispose();
  }, { once: true });
}

try {
  startClient();
} catch (error) {
  console.error(error);
  ui.lobbyError.textContent = 'Browser gagal membuat canvas game. Aktifkan akselerasi grafis lalu muat ulang.';
  ui.lobbyError.classList.add('is-error');
}
