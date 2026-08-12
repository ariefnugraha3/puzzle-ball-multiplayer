import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { env, exit } from 'node:process';

import { RealtimeService } from './realtime.js';

const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? '0.0.0.0';

const httpServer = createServer((request, response) => {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end('Zuma Rift realtime server is running.\n');
});

const realtime = new RealtimeService(httpServer);

httpServer.listen(port, host, () => {
  console.log('Zuma Rift server');
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
  httpServer.close(() => exit(0));
  setTimeout(() => exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
