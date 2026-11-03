import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createChaos } from './chaos.js';
import { createStore } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4000);
const dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data');

const chaos = createChaos({
  mode: process.env.CHAOS_MODE ?? 'ok',
  latencyMs: Number(process.env.CHAOS_LATENCY_MS ?? 0),
  rate: Number(process.env.CHAOS_RATE ?? 1),
});
const app = createApp({ store: createStore(dataDir), chaos });

app.listen(port, '0.0.0.0', () => {
  console.log(`Field Reports server on http://0.0.0.0:${port}  (data: ${dataDir})`);
  console.log(`Failure injection: http://localhost:${port}/__chaos  now ${JSON.stringify(chaos.get())}`);
});
