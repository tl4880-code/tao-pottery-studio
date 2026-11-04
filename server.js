import express from 'express';
import { JSONFilePreset } from 'lowdb/node';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const allowedGlazes = new Set(['raw', 'celadon', 'ivory', 'ink', 'ochre']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxThumbnailBytes = 250 * 1024;
const maxPots = 500;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function validatePot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('Please send a pottery object.');
  }

  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 40) {
    throw invalid('Give your piece a name between 1 and 40 characters.');
  }
  if (body.author !== undefined && (typeof body.author !== 'string' || body.author.trim().length > 30)) {
    throw invalid('Your name must be 30 characters or fewer.');
  }
  if (!Array.isArray(body.profile) || body.profile.length !== 48 ||
      !body.profile.every(radius => typeof radius === 'number' && Number.isFinite(radius) && radius >= 0.35 && radius <= 1.55)) {
    throw invalid('The shape needs 48 radius values between 0.35 and 1.55.');
  }
  if (typeof body.height !== 'number' || !Number.isFinite(body.height) || body.height < 1.8 || body.height > 3.8) {
    throw invalid('The height must be between 1.8 and 3.8.');
  }
  if (!allowedGlazes.has(body.glaze)) {
    throw invalid('Choose a valid glaze.');
  }

  if (typeof body.thumbnail !== 'string' || Buffer.byteLength(body.thumbnail, 'utf8') > maxThumbnailBytes) {
    throw invalid('The preview must be a PNG image smaller than 250 KiB.');
  }
  const encodedImage = body.thumbnail.match(/^data:image\/png;base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/);
  if (!encodedImage) throw invalid('The preview must be a PNG data URL.');
  const decodedImage = Buffer.from(encodedImage[1], 'base64');
  if (decodedImage.length < pngSignature.length || !decodedImage.subarray(0, 8).equals(pngSignature)) {
    throw invalid('The preview must contain a PNG image.');
  }

  return {
    id: randomUUID(),
    name: body.name.trim(),
    author: body.author?.trim() || 'Anonymous',
    profile: [...body.profile],
    height: body.height,
    glaze: body.glaze,
    thumbnail: body.thumbnail,
    createdAt: new Date().toISOString(),
  };
}

export async function createApp({ dataFile = resolve(projectDirectory, 'data', 'pots.json') } = {}) {
  await mkdir(dirname(dataFile), { recursive: true });
  const db = await JSONFilePreset(dataFile, { pots: [] });
  if (!db.data || !Array.isArray(db.data.pots)) {
    throw new Error('The pottery database must contain a pots array.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '400kb' }));
  let pendingWrite = Promise.resolve();

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.get('/api/pots', async (_request, response) => {
    await pendingWrite;
    response.json({ pots: db.data.pots });
  });

  app.post('/api/pots', async (request, response) => {
    const pot = validatePot(request.body);
    const write = pendingWrite.then(async () => {
      const previousPots = db.data.pots;
      db.data.pots = [pot, ...previousPots].slice(0, maxPots);
      try {
        await db.write();
      } catch (error) {
        db.data.pots = previousPots;
        throw error;
      }
    });
    // A failed write must not prevent later requests from saving.
    pendingWrite = write.catch(() => {});
    await write;
    response.status(201).json({ pot });
  });

  app.get('/vendor/three.module.js', (_request, response) => {
    response.sendFile(resolve(projectDirectory, 'node_modules/three/build/three.module.js'));
  });
  app.get('/vendor/three.core.js', (_request, response) => {
    response.sendFile(resolve(projectDirectory, 'node_modules/three/build/three.core.js'));
  });
  app.use(express.static(resolve(projectDirectory, 'public')));

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'This API endpoint does not exist.' });
  });

  app.use((error, _request, response, _next) => {
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'This request is too large. Keep the preview below 250 KiB.' });
    }
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'Please send valid JSON.' });
    }
    const status = error.status === 400 ? 400 : 500;
    if (status === 500) console.error('Pottery server error:', error);
    response.status(status).json({ error: status === 400 ? error.message : 'We could not save your piece. Please try again.' });
  });

  return app;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT) || 3210;
  const app = await createApp({ dataFile: process.env.DATA_FILE ? resolve(process.env.DATA_FILE) : undefined });
  app.listen(port, '0.0.0.0', () => {
    console.log(`Tao Studio is ready at http://localhost:${port}`);
  });
}
