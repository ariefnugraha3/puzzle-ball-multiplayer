# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the browser client. `main.js` owns Phaser gameplay rendering and UI orchestration, `network-client.js` handles WebSocket state, and `three-atmosphere.js` renders the Three.js background.
- `server/` contains the Node.js authoritative simulation, room management, and HTTP/WebSocket server. Keep gameplay decisions in `game-room.js`, not in the client.
- `test/` contains Node test files named `*.test.js`. Shared rules live in `src/game-logic.js` and `src/multiplayer-config.js` so both client and server can import them.
- `scripts/` holds manual browser and bot smoke-test utilities. `dist/` and `node_modules/` are generated and must not be edited or committed.

## Build, Test, and Development Commands

```powershell
npm.cmd ci          # Install exact locked dependencies
npm.cmd run dev     # Start Vite plus the multiplayer server
npm.cmd test        # Run all unit and WebSocket integration tests
npm.cmd run build   # Create the production bundle in dist/
npm.cmd start       # Serve the existing production build
```

The game must run through the server; opening `index.html` with `file://` will not support modules or multiplayer. Other LAN players should use the `Network` URL printed by the server.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, and single-quoted JavaScript strings. Follow existing naming: `camelCase` for functions and variables, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames. Keep comments brief and reserve them for non-obvious synchronization or collision logic. No formatter or linter is configured, so match surrounding code and run syntax checks when useful, for example `node --check server/realtime.js`.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`; there is currently no numeric coverage threshold. Add regression tests for gameplay rules, room lifecycle, reconnects, protocol validation, and 1-4 player behavior. Every change should pass `npm.cmd test` and `npm.cmd run build`. UI or networking changes should also receive a browser smoke test at desktop and mobile sizes.

## Commit & Pull Request Guidelines

This workspace has no Git history defining a convention. Use focused, imperative commits, preferably `type: summary`, such as `fix: prevent duplicate room joins`. Pull requests should explain player-visible behavior, authoritative-state implications, tests run, and latency/protocol changes. Link relevant issues and include screenshots for visual changes. Never commit secrets, logs, browser profiles, screenshots, or generated build output.
