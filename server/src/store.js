// Durable storage for the backend: a JSON "database" of committed reports plus
// image files on disk. Every write goes to a temp file first and is then renamed
// into place, so a crash never leaves a half-written file behind.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 5_000_000;
export const MIN_IMAGES = 1;
export const MAX_IMAGES = 5;

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/** Cheap structural check that catches truncated or garbage uploads. */
export function looksLikeCompleteJpeg(buf) {
  return (
    buf.length > 4 &&
    buf.subarray(0, 2).equals(JPEG_SOI) &&
    buf.subarray(buf.length - 2).equals(JPEG_EOI)
  );
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function createStore(dataDir) {
  const imagesDir = path.join(dataDir, 'images');
  const dbFile = path.join(dataDir, 'db.json');
  fs.mkdirSync(imagesDir, { recursive: true });

  /** @type {{ reports: Record<string, any> }} */
  let db = { reports: {} };
  if (fs.existsSync(dbFile)) {
    db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  }

  const persist = () => writeFileAtomic(dbFile, JSON.stringify(db, null, 2));
  const imagePath = (id, index) => path.join(imagesDir, id, `${index}.jpg`);

  return {
    getReport: id => db.reports[id] ?? null,

    listReports: () =>
      Object.values(db.reports).sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      ),

    imagePath,

    /** Stores (or overwrites) one image slot of a not-yet-committed report. */
    putImage(id, index, buf) {
      fs.mkdirSync(path.join(imagesDir, id), { recursive: true });
      writeFileAtomic(imagePath(id, index), buf);
    },

    imageSize(id, index) {
      try {
        return fs.statSync(imagePath(id, index)).size;
      } catch {
        return null;
      }
    },

    /**
     * Creates the report record. Node runs this synchronously, so the
     * existence check and the insert cannot interleave with another request.
     * Returns { created: false } when the report already exists.
     */
    commitReport(report) {
      const existing = db.reports[report.id];
      if (existing) {
        return { created: false, report: existing };
      }
      db.reports[report.id] = report;
      persist();
      return { created: true, report };
    },

    reset() {
      db = { reports: {} };
      persist();
      fs.rmSync(imagesDir, { recursive: true, force: true });
      fs.mkdirSync(imagesDir, { recursive: true });
    },
  };
}
