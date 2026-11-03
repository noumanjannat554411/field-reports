import express from 'express';
import multer from 'multer';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MIN_IMAGES,
  looksLikeCompleteJpeg,
} from './store.js';
import { MODES } from './chaos.js';

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MAX_DESCRIPTION = 2000;

function toPublic(report) {
  return {
    id: report.id,
    description: report.description,
    createdAt: report.createdAt,
    receivedAt: report.receivedAt,
    images: report.images.map(img => ({
      index: img.index,
      size: img.size,
      url: `/images/${report.id}/${img.index}.jpg`,
    })),
  };
}

export function createApp({ store, chaos, log = console.log }) {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  });

  app.use((req, _res, next) => {
    log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- failure injection controls ------------------------------------------
  app.get('/__chaos', (req, res) => {
    if (req.accepts(['json', 'html']) === 'html') {
      return res.type('html').send(chaosPage(chaos.get()));
    }
    res.json(chaos.get());
  });
  app.post('/__chaos', express.json(), express.urlencoded({ extended: false }), (req, res) => {
    try {
      const config = chaos.set(req.body ?? {});
      log(`[chaos] now ${JSON.stringify(config)}`);
      if (req.is('urlencoded')) {
        return res.redirect(303, '/__chaos');
      }
      res.json(config);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.delete('/__admin/reports', (_req, res) => {
    store.reset();
    log('[admin] server data wiped');
    res.json({ ok: true });
  });

  // ---- report API ----------------------------------------------------------
  const api = express.Router();
  api.use(chaos.middleware);

  api.param('id', (req, res, next, id) => {
    if (!ID_PATTERN.test(id)) {
      return res.status(400).json({ error: 'invalid report id' });
    }
    next();
  });

  api.get('/', (_req, res) => {
    res.json({ reports: store.listReports().map(toPublic) });
  });

  // Upload (or re-upload) one image. Re-sending the same slot overwrites it,
  // so retries are safe. Once a report is committed its images are frozen.
  api.put('/:id/images/:index', (req, res) => {
    const { id } = req.params;
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_IMAGES) {
      return res.status(400).json({ error: 'invalid image index' });
    }
    const committed = store.getReport(id);
    if (committed) {
      const img = committed.images.find(i => i.index === index);
      return res.json({ index, size: img?.size ?? null, committed: true });
    }
    upload.single('image')(req, res, err => {
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return res
          .status(413)
          .json({ error: `image exceeds ${MAX_IMAGE_BYTES} bytes` });
      }
      if (err) {
        // Usually the client went away mid-upload; nothing was stored.
        return res.status(400).json({ error: `upload failed: ${err.message}` });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'missing "image" file field' });
      }
      if (!looksLikeCompleteJpeg(req.file.buffer)) {
        return res.status(422).json({ error: 'image is not a complete JPEG' });
      }
      store.putImage(id, index, req.file.buffer);
      res.json({ index, size: req.file.size, committed: false });
    });
  });

  // Create the report from already-uploaded images. Idempotent on the
  // client-generated id: repeating it returns the existing report.
  api.post('/:id/commit', express.json({ limit: '64kb' }), (req, res) => {
    const { id } = req.params;
    const existing = store.getReport(id);
    if (existing) {
      return res.status(200).json({ status: 'exists', report: toPublic(existing) });
    }

    const { description, createdAt, images } = req.body ?? {};
    if (typeof description !== 'string' || description.trim() === '') {
      return res.status(400).json({ error: 'description is required' });
    }
    if (description.length > MAX_DESCRIPTION) {
      return res.status(400).json({ error: 'description is too long' });
    }
    if (
      !Array.isArray(images) ||
      images.length < MIN_IMAGES ||
      images.length > MAX_IMAGES
    ) {
      return res
        .status(400)
        .json({ error: `a report needs ${MIN_IMAGES}-${MAX_IMAGES} images` });
    }
    const indices = images.map(i => i?.index);
    const expected = images.map((_, i) => i);
    if (indices.some((v, i) => v !== expected[i])) {
      return res.status(400).json({ error: 'image indices must be 0..n-1 in order' });
    }

    // Any slot that is absent or whose size doesn't match what the client
    // holds gets re-requested; the client re-uploads just those.
    const missing = images
      .filter(img => store.imageSize(id, img.index) !== img.size)
      .map(img => img.index);
    if (missing.length > 0) {
      return res.status(409).json({ error: 'images missing or incomplete', missing });
    }

    const { report } = store.commitReport({
      id,
      description: description.trim(),
      createdAt: typeof createdAt === 'string' ? createdAt : null,
      receivedAt: new Date().toISOString(),
      images: images.map(img => ({ index: img.index, size: img.size })),
    });
    res.status(201).json({ status: 'created', report: toPublic(report) });
  });

  app.use('/reports', api);

  app.get('/images/:id/:file', (req, res) => {
    const { id, file } = req.params;
    const match = /^(\d)\.jpg$/.exec(file);
    if (!ID_PATTERN.test(id) || !match || !store.getReport(id)) {
      return res.status(404).end();
    }
    res.sendFile(store.imagePath(id, Number(match[1])));
  });

  return app;
}

function chaosPage(config) {
  const options = MODES.map(
    m => `<option ${m === config.mode ? 'selected' : ''}>${m}</option>`,
  ).join('');
  return `<!doctype html><meta name="viewport" content="width=device-width">
<title>Field Reports chaos</title>
<style>body{font:16px system-ui;margin:24px;max-width:480px}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:6px}</style>
<h1>Failure injection</h1>
<pre>${JSON.stringify(config, null, 2)}</pre>
<form method="post">
<label>Mode <select name="mode">${options}</select></label>
<label>Latency ms <input name="latencyMs" type="number" min="0" value="${config.latencyMs}"></label>
<label>Rate 0..1 <input name="rate" type="number" min="0" max="1" step="0.1" value="${config.rate}"></label>
<label>Only next N requests <input name="remaining" type="number" min="0" value="${config.remaining ?? ''}" placeholder="forever"></label>
<button>Apply</button>
</form>
<form method="post"><input type="hidden" name="mode" value="ok"><input type="hidden" name="latencyMs" value="0"><input type="hidden" name="rate" value="1"><input type="hidden" name="remaining" value=""><button>Reset to healthy</button></form>`;
}
