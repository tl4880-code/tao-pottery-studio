import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';

const thumbnail = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZZkAAAAASUVORK5CYII=';
const samplePot = () => ({
  name: 'Morning cup',
  author: 'Lin',
  profile: Array.from({ length: 48 }, (_, index) => 0.65 + index * 0.008),
  height: 2.6,
  glaze: 'celadon',
  thumbnail,
});

async function start(dataFile) {
  const app = await createApp({ dataFile });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tao-studio-test-'));
  const dataFile = join(directory, 'pots.json');
  const running = await start(dataFile);
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...running, dataFile, directory };
}

const post = (url, body) => fetch(`${url}/api/pots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('starts with an empty gallery and reports health', async t => {
  const { url } = await fixture(t);
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${url}/api/pots`)).json(), { pots: [] });
});

test('saves normalized data and reads the same piece after restarting the app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tao-studio-persist-'));
  const dataFile = join(directory, 'pots.json');
  let running = await start(dataFile);
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = { ...samplePot(), name: '  Morning cup  ', author: '  ', unexpected: 'discard this field' };
  const response = await post(running.url, input);
  assert.equal(response.status, 201);
  const { pot } = await response.json();
  assert.equal(pot.name, 'Morning cup');
  assert.equal(pot.author, 'Anonymous');
  assert.match(pot.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(pot.createdAt)));
  assert.equal(pot.unexpected, undefined);
  assert.deepEqual(pot.profile, input.profile);
  assert.equal(pot.thumbnail, thumbnail);
  assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')).pots, [pot]);
  await running.close();
  running = await start(dataFile);
  assert.deepEqual(await (await fetch(`${running.url}/api/pots`)).json(), { pots: [pot] });
});

test('rejects invalid shape, metadata, and image input without saving it', async t => {
  const { url } = await fixture(t);
  const badValues = [
    null,
    [],
    { ...samplePot(), name: ' ' },
    { ...samplePot(), name: 'x'.repeat(41) },
    { ...samplePot(), author: 'x'.repeat(31) },
    { ...samplePot(), author: 12 },
    { ...samplePot(), profile: [1, 1] },
    { ...samplePot(), profile: Array(48).fill('0.9') },
    { ...samplePot(), profile: Array(48).fill(0.34) },
    { ...samplePot(), profile: Array(48).fill(1.56) },
    { ...samplePot(), height: 1.79 },
    { ...samplePot(), height: 3.81 },
    { ...samplePot(), height: '2.6' },
    { ...samplePot(), glaze: 'anything' },
    { ...samplePot(), thumbnail: 'data:text/html;base64,PHNjcmlwdD4=' },
    { ...samplePot(), thumbnail: 'data:image/png;base64,aGVsbG8=' },
    { ...samplePot(), thumbnail: `data:image/png;base64,${'A'.repeat(250 * 1024)}` },
  ];
  for (const input of badValues) {
    const response = await post(url, input);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.deepEqual(await (await fetch(`${url}/api/pots`)).json(), { pots: [] });
});

test('handles invalid JSON and oversized requests with JSON errors', async t => {
  const { url } = await fixture(t);
  for (const [body, expectedStatus] of [
    ['{broken JSON', 400],
    [JSON.stringify({ extra: 'x'.repeat(410 * 1024) }), 413],
  ]) {
    const response = await fetch(`${url}/api/pots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('concurrent saves keep every piece on disk and in the gallery', async t => {
  const { url, dataFile } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => post(url, {
    ...samplePot(), name: `Piece ${index}`,
  })));
  for (const response of responses) assert.equal(response.status, 201);
  const saved = await Promise.all(responses.map(response => response.json()));
  const { pots } = await (await fetch(`${url}/api/pots`)).json();
  assert.equal(pots.length, 20);
  assert.equal(new Set(pots.map(pot => pot.id)).size, 20);
  assert.deepEqual(new Set(pots.map(pot => pot.id)), new Set(saved.map(({ pot }) => pot.id)));
  assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')).pots, pots);
});

test('keeps the newest 500 pieces when the gallery reaches its limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tao-studio-cap-'));
  const dataFile = join(directory, 'pots.json');
  const existing = Array.from({ length: 500 }, (_, index) => ({ ...samplePot(), id: `old-${index}` }));
  await writeFile(dataFile, JSON.stringify({ pots: existing }));
  const running = await start(dataFile);
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { pot } = await (await post(running.url, samplePot())).json();
  const { pots } = await (await fetch(`${running.url}/api/pots`)).json();
  assert.equal(pots.length, 500);
  assert.equal(pots[0].id, pot.id);
  assert.equal(pots.at(-1).id, 'old-498');
});

test('serves the Three.js module and returns a JSON API 404', async t => {
  const { url } = await fixture(t);
  const moduleResponse = await fetch(`${url}/vendor/three.module.js`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type'), /javascript/);
  const missing = await fetch(`${url}/api/missing`);
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, 'string');
});
