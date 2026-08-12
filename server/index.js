import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RealtimeService } from './realtime.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(projectRoot, 'dist');
const development = process.argv.includes('--dev');
const portArgument = process.argv.find((value) => value.startsWith('--port='));
const port = Number(portArgument?.split('=')[1] ?? process.env.PORT ?? 5173);
const host = process.env.HOST ?? '0.0.0.0';

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

let vite = null;
const httpServer = createServer((request, response) => {
  if (vite) {
    vite.middlewares(request, response, (error) => {
      if (error) {
        console.error(error);
        response.statusCode = 500;
        response.end('Vite middleware error');
      }
    });
    return;
  }
  serveProduction(request, response);
});

if (development) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    root: projectRoot,
    appType: 'spa',
    server: {
      middlewareMode: true,
      hmr: { server: httpServer }
    }
  });
} else if (!existsSync(join(distRoot, 'index.html'))) {
  console.error('Build produksi belum ada. Jalankan "npm run build" terlebih dahulu.');
  process.exit(1);
}

function serveProduction(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = resolve(distRoot, requestedPath);
  if (!filePath.startsWith(distRoot + sep) && filePath !== distRoot) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(distRoot, 'index.html');

  const extension = extname(filePath).toLowerCase();
  const cacheControl = filePath.includes(`${sep}assets${sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  response.writeHead(200, {
    'Content-Type': mimeTypes[extension] ?? 'application/octet-stream',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  });
  createReadStream(filePath).pipe(response);
}

const realtime = new RealtimeService(httpServer);

httpServer.listen(port, host, () => {
  console.log(`Zuma Rift ${development ? 'development' : 'production'} server`);
  console.log(`Local:   http://localhost:${port}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`Network: http://${address.address}:${port}`);
      }
    }
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await realtime.close();
  await vite?.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
