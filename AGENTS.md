# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the browser client. `main.js` owns Phaser rendering and UI orchestration, `network-client.js` switches between the external WebSocket server and local offline play, and `three-atmosphere.js` renders the Three.js background.
- `src/game-room.js` contains the local offline simulation. Shared gameplay rules live in `src/game-logic.js` and multiplayer tuning lives in `src/multiplayer-config.js`.
- `test/` contains Node test files named `*.test.js` for gameplay rules, the local room simulation, and offline network-client behavior.
- The authoritative online server is maintained in a separate project. This repository must remain deployable as a static client.
- `dist/` and `node_modules/` are generated and must not be edited or committed.

## Build, Test, and Development Commands

```powershell
npm.cmd ci          # Install exact locked dependencies
npm.cmd run dev     # Start the Vite development server
npm.cmd test        # Run all client and offline simulation tests
npm.cmd run build   # Create the production bundle in dist/
npm.cmd start       # Preview the production build
```

Run the game through Vite because opening `index.html` with `file://` will not support modules. Configure the external multiplayer endpoint with `VITE_WS_URL`; offline mode does not require a server connection.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, and single-quoted JavaScript strings. Follow existing naming: `camelCase` for functions and variables, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames. Keep comments brief and reserve them for non-obvious synchronization or collision logic. No formatter or linter is configured, so match surrounding code and run syntax checks when useful, for example `node --check src/network-client.js`.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`; there is currently no numeric coverage threshold. Add regression tests for gameplay rules, offline room lifecycle, mode transitions, and network-client behavior. Every change should pass `npm.cmd test` and `npm.cmd run build`. UI or networking changes should also receive a browser smoke test at desktop and mobile sizes.

## Commit & Pull Request Guidelines

This workspace has no Git history defining a convention. Use focused, imperative commits, preferably `type: summary`, such as `fix: preserve offline session state`. Pull requests should explain player-visible behavior, tests run, and any protocol changes. Link relevant issues and include screenshots for visual changes. Never commit secrets, logs, browser profiles, screenshots, or generated build output.
