# Zuma Rift Multiplayer

Game marble shooter kooperatif bergaya Zuma untuk 1-4 pemain. Phaser 3 menangani gameplay 2D, Three.js membangun atmosfer latar, dan server Node.js authoritative menjaga semua pemain tetap sinkron.

## Kebutuhan

- Node.js 20.19 atau lebih baru
- Browser modern dengan WebGL dan WebSocket

## Menjalankan Development

```powershell
npm.cmd install
npm.cmd run dev
```

Server akan menampilkan dua jenis alamat:

- `Local`, misalnya `http://localhost:5173`, untuk perangkat yang menjalankan server.
- `Network`, misalnya `http://192.168.1.10:5173`, untuk perangkat lain pada jaringan Wi-Fi/LAN yang sama.

Client saat ini terhubung ke server authoritative publik `ws://103.93.135.174/ws`, sebagaimana diatur dalam `.env`. Karena room berada di server publik, pemain boleh membuka frontend dari jaringan yang berbeda; mereka hanya perlu memakai kode room yang sama. Jika Windows Firewall bertanya saat frontend dibuka melalui LAN, izinkan akses pada jaringan privat.

Game multiplayer **harus dijalankan melalui server**. Membuka `index.html` langsung lewat `file://` tidak dapat menjalankan modul, room, atau koneksi WebSocket dengan benar.

## Cara Bermain

1. Isi nama lalu pilih **Buat Room**, atau masukkan kode lima karakter untuk bergabung.
2. Bagikan kode room kepada maksimal tiga pemain lain.
3. Host dapat memulai pertandingan dengan 1, 2, 3, atau 4 pemain.
4. Hancurkan rangkaian minimal tiga bola berwarna sama sebelum rantai mencapai gerbang.
5. Selesaikan ketiga level untuk memenangkan campaign bersama.

Jumlah bola dan kecepatan rantai menyesuaikan jumlah pemain. Skor, combo, rantai, level, pause, kalah, dan kemenangan merupakan state bersama yang diputuskan server.

## Kontrol

- Mouse atau sentuhan: membidik
- Klik atau tap: menembak
- `Spasi` atau klik kanan: menukar bola aktif
- `P` atau `Esc`: jeda/lanjut, khusus host
- Tombol HUD: suara, jeda, dan tukar bola

Jika koneksi terputus singkat, slot pemain disimpan selama 15 detik dan client mencoba tersambung kembali otomatis. Jika host keluar, hak host berpindah ke pemain aktif berikutnya.

## Build Produksi

```powershell
npm.cmd run build
npm.cmd start
```

## Deploy Server Terpisah

Kalau mau host backend multiplayer di VPS sebagai project sendiri, pakai folder [`vps-server`](./vps-server).

```powershell
cd vps-server
npm.cmd install
npm.cmd start
```

Lalu build client dengan alamat WebSocket VPS, misalnya:

```powershell
$env:VITE_WS_URL='wss://game-domain-anda.com/ws'
npm.cmd run build
```

Konfigurasi aktif repo ini berada di `.env`:

```dotenv
VITE_WS_URL=ws://103.93.135.174/ws
```

Alamat `ws://` hanya dapat dipakai dari halaman HTTP. Jika frontend nantinya dipasang pada HTTPS, backend juga harus menyediakan `wss://` dan nilai tersebut harus diganti agar browser tidak memblokir mixed content.

Server produksi melayani folder `dist/` dan endpoint WebSocket `/ws` pada origin yang sama. Port default adalah `5173`; port dapat diubah di PowerShell:

```powershell
$env:PORT=8080
npm.cmd start
```

Untuk deployment publik, gunakan host Node.js yang mendukung proses jangka panjang dan WebSocket. Reverse proxy harus meneruskan upgrade WebSocket pada `/ws`. Saat halaman memakai HTTPS, client otomatis memakai `wss://`.

Room saat ini disimpan di memori satu proses server. Jika aplikasi dijalankan pada beberapa instance, gunakan sticky session atau shared room adapter sebelum melakukan horizontal scaling.

## Latensi

- Simulasi authoritative berjalan 60 Hz.
- Snapshot state dikirim 30 Hz dan snapshot lama dilewati jika client mengalami backpressure.
- Tembakan pemain lokal diprediksi langsung lalu direkonsiliasi dengan server.
- Gerak rantai dan proyektil diekstrapolasi secara terbatas agar tetap halus.
- WebSocket memakai `TCP_NODELAY`, tanpa kompresi per-message, payload kecil, dan aim dibatasi 30 Hz.

Untuk hasil terbaik melalui internet, tempatkan server di region yang dekat dengan seluruh pemain dan gunakan koneksi kabel atau Wi-Fi 5 GHz yang stabil.

## Verifikasi

```powershell
npm.cmd test
npm.cmd run build
```

Test mencakup aturan match/collision, campaign 1-4 pemain, batas room, host migration, reconnect, session replacement, pause, kemenangan akhir, dan integrasi WebSocket empat client.

## Struktur Utama

- `server/index.js`: HTTP development/production server
- `server/realtime.js`: room manager, protokol WebSocket, heartbeat, dan broadcast
- `server/game-room.js`: simulasi gameplay authoritative
- `src/main.js`: scene Phaser, input, prediksi lokal, HUD, dan lobby
- `src/network-client.js`: koneksi, ping, reconnect, dan sinkronisasi client
- `src/three-atmosphere.js`: atmosfer Three.js
- `src/game-logic.js`: lintasan, collision, match, combo, dan skor
- `test/`: unit test dan integration test server
