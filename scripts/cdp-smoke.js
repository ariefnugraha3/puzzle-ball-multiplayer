import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const port = Number(process.argv.find((value) => value.startsWith('--port='))?.slice(7) ?? 9222);
const output = process.argv.find((value) => value.startsWith('--output='))?.slice(9) ?? 'cdp-smoke.png';
const waitMs = Number(process.argv.find((value) => value.startsWith('--wait='))?.slice(7) ?? 2500);
const navigate = process.argv.find((value) => value.startsWith('--navigate='))?.slice(11) ?? '';
const configuredWebSocketUrl = process.argv.find((value) => value.startsWith('--ws-url='))?.slice(9) ?? '';
const scenario = process.argv.find((value) => value.startsWith('--scenario='))?.slice(11) ?? '';
const viewportWidth = Number(process.argv.find((value) => value.startsWith('--width='))?.slice(8) ?? 0);
const viewportHeight = Number(process.argv.find((value) => value.startsWith('--height='))?.slice(9) ?? 0);
const clearStorage = process.argv.includes('--clear-storage');
const emulateTouch = process.argv.includes('--touch');

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

let targets = [];
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
    if (targets.length) break;
  } catch {}
  await sleep(100);
}

const pageTargets = targets.filter((item) => item.type === 'page');
const target = pageTargets.find((item) => item.url.includes('127.0.0.1')) ?? pageTargets[0];
if (!target) throw new Error('Chrome DevTools target was not found.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

let sequence = 0;
const pending = new Map();
const runtimeErrors = [];
const webSocketEvents = [];
const webSocketSummary = {
  created: 0,
  closed: 0,
  sentTypes: {},
  receivedTypes: {}
};

function incrementType(direction, payload) {
  let type = 'binary';
  try {
    type = JSON.parse(payload).type ?? 'unknown';
  } catch {}
  const bucket = direction === 'sent' ? webSocketSummary.sentTypes : webSocketSummary.receivedTypes;
  bucket[type] = (bucket[type] ?? 0) + 1;
  if (!['snapshot', 'ping', 'pong', 'aim'].includes(type)) {
    webSocketEvents.push({ direction, type, payload: payload.slice(0, 500) });
  }
}

socket.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.id && pending.has(message.id)) {
    const commandState = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(commandState.timeout);
    if (message.error) commandState.reject(new Error(message.error.message));
    else commandState.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    runtimeErrors.push(details?.exception?.description ?? details?.text ?? 'Unknown runtime exception');
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    runtimeErrors.push(message.params.entry.text);
  }
  if (message.method === 'Network.webSocketCreated') webSocketSummary.created += 1;
  if (message.method === 'Network.webSocketClosed') webSocketSummary.closed += 1;
  if (message.method === 'Network.webSocketFrameSent') {
    incrementType('sent', message.params.response?.payloadData ?? '');
  }
  if (message.method === 'Network.webSocketFrameReceived') {
    incrementType('received', message.params.response?.payloadData ?? '');
  }
});

socket.on('close', () => {
  for (const commandState of pending.values()) {
    clearTimeout(commandState.timeout);
    commandState.reject(new Error('Chrome DevTools connection closed.'));
  }
  pending.clear();
});

function command(method, params = {}, timeoutMs = 8000) {
  sequence += 1;
  const id = sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome DevTools command timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed.');
  return result.result.value;
}

async function waitFor(expression, label, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function connectBot(url, roomCode, index) {
  return new Promise((resolve, reject) => {
    const bot = {
      socket: new WebSocket(url, { perMessageDeflate: false }),
      name: `Browser Bot ${index}`,
      snapshot: null
    };
    const timeout = setTimeout(() => reject(new Error(`${bot.name} could not join.`)), 8000);
    bot.socket.once('error', reject);
    bot.socket.once('open', () => {
      bot.socket.send(JSON.stringify({
        type: 'joinRoom',
        roomCode,
        sessionId: `browser-smoke-bot-${index}-${Date.now()}`,
        name: bot.name
      }));
    });
    bot.socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'snapshot') bot.snapshot = message;
      if (message.type === 'roomJoined') {
        clearTimeout(timeout);
        resolve(bot);
      }
      if (message.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`${bot.name}: ${message.message}`));
      }
    });
  });
}

const bots = [];
try {
  await Promise.all([
    command('Page.enable'),
    command('Runtime.enable'),
    command('Log.enable'),
    command('Network.enable')
  ]);
  if (viewportWidth > 0 && viewportHeight > 0) {
    await command('Emulation.setDeviceMetricsOverride', {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: 1,
      mobile: emulateTouch || viewportWidth <= 760
    });
  }
  if (emulateTouch) {
    await command('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    });
  }
  if ((scenario === 'host' || clearStorage) && navigate) {
    await command('Storage.clearDataForOrigin', {
      origin: new URL(navigate).origin,
      storageTypes: 'all'
    });
  }
  if (navigate) await command('Page.navigate', { url: navigate });

  if (scenario === 'host') {
    if (!navigate) throw new Error('The host scenario requires --navigate.');
    await waitFor(
      `document.getElementById('connection-text')?.textContent === 'Online'`,
      'the browser client to connect'
    );
    await evaluate(`(() => {
      const input = document.getElementById('player-name');
      input.value = 'Browser Host';
      document.getElementById('create-room-btn').click();
      return true;
    })()`);
    await waitFor(
      `/^[A-Z2-9]{5}$/.test(document.getElementById('room-code-display')?.textContent?.trim() ?? '')`,
      'the browser client to create a room'
    );

    const roomCode = await evaluate(`document.getElementById('room-code-display').textContent.trim()`);
    const gameUrl = new URL(configuredWebSocketUrl || navigate);
    if (!configuredWebSocketUrl) {
      gameUrl.protocol = gameUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      gameUrl.pathname = '/ws';
      gameUrl.search = '';
      gameUrl.hash = '';
    }
    bots.push(...await Promise.all([1, 2, 3].map((index) => connectBot(gameUrl.href, roomCode, index))));

    await waitFor(
      `document.querySelectorAll('#lobby-player-list .lobby-slot:not(.is-empty)').length === 4`,
      'all four players to appear in the lobby'
    );
    await evaluate(`document.getElementById('start-room-btn').click()`);
    await waitFor(
      `document.getElementById('overlay').classList.contains('hidden') && document.querySelectorAll('.roster-name').length === 4`,
      'the four-player match to start'
    );

    const canvas = await evaluate(`(() => {
      const rect = document.querySelector('#game-layer canvas').getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    const x = canvas.left + canvas.width * (720 / 1280);
    const y = canvas.top + canvas.height * (100 / 720);
    if (emulateTouch) {
      await command('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
      });
      await command('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
      });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

      const fireButton = await evaluate(`(() => {
        const element = document.getElementById('mobile-fire-btn');
        const rect = element?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : null;
      })()`);
      if (!fireButton) throw new Error('The mobile fire button is not visible.');
      await command('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...fireButton, radiusX: 8, radiusY: 8, force: 1, id: 2 }]
      });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }

    await waitFor(
      `document.getElementById('balls-left')?.textContent !== '--'`,
      'the authoritative game snapshot'
    );
    await sleep(waitMs);
  } else {
    await sleep(waitMs);
  }

  const diagnostics = JSON.parse(await evaluate(`JSON.stringify({
    url: location.href,
    connection: document.getElementById('connection-text')?.textContent,
    ping: document.getElementById('ping-value')?.textContent,
    overlayHidden: document.getElementById('overlay')?.classList.contains('hidden'),
    roomCode: document.getElementById('room-badge-code')?.textContent,
    roster: [...document.querySelectorAll('.roster-name')].map((node) => node.textContent),
    ballCount: document.getElementById('balls-left')?.textContent,
    level: document.getElementById('level')?.textContent,
    canvases: document.querySelectorAll('canvas').length,
    coarsePointer: matchMedia('(any-pointer: coarse)').matches,
    mobileFireVisible: getComputedStyle(document.getElementById('mobile-controls')).display !== 'none',
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      visualWidth: visualViewport?.width,
      visualHeight: visualViewport?.height,
      visualOffsetLeft: visualViewport?.offsetLeft,
      visualOffsetTop: visualViewport?.offsetTop
    },
    controlRects: Object.fromEntries(['#player-roster', '.ammo-panel', '#mobile-controls'].map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return [selector, rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null];
    })),
    lobbyError: document.getElementById('lobby-error')?.textContent
  })`));
  let screenshotError = null;
  try {
    const screenshot = await command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true
    }, 30_000);
    writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
  } catch (error) {
    screenshotError = error.message;
  }

  const report = { diagnostics, runtimeErrors, webSocketSummary, webSocketEvents, screenshotError };
  console.log(JSON.stringify(report, null, 2));

  if (scenario === 'host') {
    const failures = [];
    if (diagnostics.connection !== 'Online') failures.push('browser is not online');
    if (!diagnostics.overlayHidden) failures.push('match overlay is still visible');
    if (diagnostics.roster.length !== 4) failures.push('four-player roster was not rendered');
    if (diagnostics.canvases < 2) failures.push('Phaser or Three.js canvas is missing');
    if (emulateTouch && !diagnostics.mobileFireVisible) failures.push('mobile fire control is hidden');
    if ((webSocketSummary.sentTypes.fire ?? 0) < 1) failures.push('browser fire input was not sent');
    if ((webSocketSummary.receivedTypes.projectileSpawn ?? 0) < 1) failures.push('authoritative projectile was not received');
    if (runtimeErrors.length) failures.push('browser runtime errors were reported');
    if (failures.length) throw new Error(`Browser smoke test failed: ${failures.join(', ')}.`);
  }
} finally {
  for (const bot of bots) bot.socket.close(1000, 'Browser smoke test finished');
  socket.close();
}
