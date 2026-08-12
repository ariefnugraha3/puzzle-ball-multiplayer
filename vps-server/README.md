# Zuma Rift Server

Project ini berisi backend multiplayer standalone untuk di-host di VPS.

## Jalankan

```powershell
npm.cmd install
npm.cmd start
```

## Environment

- `PORT` default `8080`
- `HOST` default `0.0.0.0`

## Client

Client web harus di-build dengan `VITE_WS_URL` yang mengarah ke WebSocket VPS, misalnya:

```powershell
$env:VITE_WS_URL='wss://game-domain-anda.com/ws'
npm.cmd run build
```
