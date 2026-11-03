import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createChaos } from '../src/chaos.js';
import { createStore } from '../src/store.js';

let server, base, chaos, dataDir;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
  chaos = createChaos();
  const app = createApp({ store: createStore(dataDir), chaos, log: () => {} });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ID = 'report-0001-abcdef';
const jpeg = (n = 1000) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 7), Buffer.from([0xff, 0xd9])]);

function putImage(id, index, buf) {
  const form = new FormData();
  form.append('image', new Blob([buf], { type: 'image/jpeg' }), `${index}.jpg`);
  return fetch(`${base}/reports/${id}/images/${index}`, { method: 'PUT', body: form });
}

function commit(id, sizes, description = 'Broken pipe') {
  return fetch(`${base}/reports/${id}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      description,
      createdAt: '2026-01-01T00:00:00.000Z',
      images: sizes.map((size, index) => ({ index, size })),
    }),
  });
}

const listIds = async () =>
  (await (await fetch(`${base}/reports`)).json()).reports.map(r => r.id);

test('upload then commit creates exactly one report', async () => {
  const img = jpeg();
  assert.equal((await putImage(ID, 0, img)).status, 200);
  const res = await commit(ID, [img.length]);
  assert.equal(res.status, 201);
  assert.deepEqual(await listIds(), [ID]);
});

test('repeated commits and re-uploads never duplicate', async () => {
  const img = jpeg();
  await putImage(ID, 0, img);
  await putImage(ID, 0, img);
  assert.equal((await commit(ID, [img.length])).status, 201);
  assert.equal((await commit(ID, [img.length])).status, 200);
  assert.equal((await putImage(ID, 0, img)).status, 200);
  assert.equal((await commit(ID, [img.length])).status, 200);
  assert.deepEqual(await listIds(), [ID]);
});

test('commit with missing or wrong-size images asks for them again', async () => {
  const img = jpeg();
  await putImage(ID, 0, img);
  const res = await commit(ID, [img.length, 500, img.length + 1]);
  assert.equal(res.status, 409);
  assert.deepEqual((await res.json()).missing, [1, 2]);
  assert.deepEqual(await listIds(), []);
});

test('validation: blank description, 0 images, 6 images, oversize, truncated', async () => {
  assert.equal((await commit(ID, [10], '   ')).status, 400);
  assert.equal((await commit(ID, [])).status, 400);
  assert.equal((await commit(ID, [1, 1, 1, 1, 1, 1])).status, 400);
  assert.equal((await putImage(ID, 5, jpeg())).status, 400);
  assert.equal((await putImage(ID, 0, jpeg(5_000_001))).status, 413);
  assert.equal((await putImage(ID, 0, jpeg().subarray(0, 500))).status, 422);
});

test('lost response: commit is stored even though the client saw a dropped connection', async () => {
  const img = jpeg();
  await putImage(ID, 0, img);
  chaos.set({ mode: 'lose-response', remaining: 1 });
  await assert.rejects(commit(ID, [img.length]));
  // The client retries; it must get success, not a second report.
  assert.equal((await commit(ID, [img.length])).status, 200);
  assert.deepEqual(await listIds(), [ID]);
});

test('chaos modes produce the advertised failures and expire', async () => {
  chaos.set({ mode: 'error', remaining: 1 });
  assert.equal((await fetch(`${base}/reports`)).status, 500);
  assert.equal((await fetch(`${base}/reports`)).status, 200);
  chaos.set({ mode: 'refuse', remaining: 1 });
  assert.equal((await fetch(`${base}/reports`)).status, 503);
  chaos.set({ mode: 'reject', remaining: 1 });
  assert.equal((await fetch(`${base}/reports`)).status, 422);
  chaos.set({ mode: 'drop', remaining: 1 });
  await assert.rejects(fetch(`${base}/reports`));
  chaos.set({ mode: 'hang', remaining: 1 });
  await assert.rejects(fetch(`${base}/reports`, { signal: AbortSignal.timeout(300) }));
  assert.equal(chaos.get().mode, 'ok');
});

test('committed images are served', async () => {
  const img = jpeg(2000);
  await putImage(ID, 0, img);
  await commit(ID, [img.length]);
  const body = await fetch(`${base}/reports`).then(r => r.json());
  const res = await fetch(base + body.reports[0].images[0].url);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).length, img.length);
});
