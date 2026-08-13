# Zuma Rift Client

A browser client for Zuma Rift, a cooperative Zuma-style marble shooter. Phaser 3 handles the 2D gameplay, Three.js renders the background atmosphere, and multiplayer connects to an external authoritative WebSocket server through `VITE_WS_URL`.

The client also includes a local offline simulation so the game remains playable without a server connection.

## Requirements

- Node.js 20.19 or newer
- A modern browser with WebGL and WebSocket support

## Development

```powershell
npm.cmd install
npm.cmd run dev
```

Vite prints the local and LAN URLs. Use the LAN URL if testing from another device on the same network.

## Configuration

Set the multiplayer server URL in `.env`:

```dotenv
VITE_WS_URL=ws://103.93.135.174/ws
```

Use `ws://` from HTTP pages and `wss://` from HTTPS pages. If `VITE_WS_URL` is omitted, the client falls back to `/ws` on the current origin.

## How To Play

1. Enter a name.
2. Choose **Play Offline** to start immediately, or choose **Create Room** / **Join** to use the configured online server.
3. In online mode, share the room code with up to three other players.
4. Destroy groups of at least three same-colored balls before the chain reaches the gate.
5. Clear all three levels to win the campaign.

## Controls

- Mouse or touch: aim
- Click or tap: fire
- `Space` or right click: swap the active ball
- `P` or `Esc`: pause/resume
- HUD buttons: sound, pause, and ball swap

## Build And Preview

```powershell
npm.cmd run build
npm.cmd start
```

The production bundle is written to `dist/`. Deploy that folder with any static hosting provider.

## Verification

```powershell
npm.cmd test
npm.cmd run build
```

Tests cover shared game logic, local/offline room simulation, and the browser network client's offline path.

## Main Structure

- `src/main.js`: Phaser scene, input, local prediction, HUD, and lobby
- `src/network-client.js`: online WebSocket client, offline mode, ping, reconnect, and state synchronization
- `src/game-room.js`: local offline gameplay simulation
- `src/game-logic.js`: pathing, collision, match, combo, and scoring
- `src/multiplayer-config.js`: shared multiplayer tuning constants
- `src/three-atmosphere.js`: Three.js atmosphere
- `test/`: unit tests for gameplay and offline client behavior
