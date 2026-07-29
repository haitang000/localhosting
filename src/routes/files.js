import express, { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import * as svc from '../instances.js';
import * as files from '../files.js';

/**
 * File manager routes, all hanging off /api/instances/:id/files.
 *
 * They live in their own router because uploads arrive as base64 inside a JSON
 * body (the same trick the static-site drop uses — no multipart parser in this
 * project), so they need a body limit measured in tens of megabytes while every
 * other endpoint stays on the 256kb one. Mounting this before the global parser
 * in server.js is what keeps that limit from leaking to the rest of the API.
 *
 * Paths that do not match fall straight through to the main instance router.
 */
export const router = Router();

// Big enough for the largest allowed upload after base64 inflation (+ overhead).
const uploadJson = express.json({
  limit: `${Math.ceil((config.fileUploadMaxBytes * 1.4) / 1048576) + 1}mb`,
});
const editJson = express.json({ limit: `${Math.ceil((config.fileEditMaxBytes * 1.4) / 1048576) + 1}mb` });

router.use('/:id/files', requireAuth);

const instance = (req) => svc.getInstance(req.params.id, req.user);

router.get('/:id/files', async (req, res) => {
  res.json(await files.list(instance(req), req.query.path));
});

router.get('/:id/files/content', async (req, res) => {
  res.json(await files.read(instance(req), req.query.path));
});

/** Raw bytes for a file, a .tar for a directory. */
router.get('/:id/files/download', async (req, res) => {
  const { stream, filename, size, contentType } = await files.download(instance(req), req.query.path);
  res.setHeader('Content-Type', contentType);
  if (size != null) res.setHeader('Content-Length', String(size));
  // Two spellings of the name: the RFC 5987 one is what every current browser
  // actually uses and it carries the real UTF-8 name, while the plain `filename`
  // fallback has to be forced down to printable ASCII — header values are
  // latin1, so a Chinese or emoji filename in there throws ERR_INVALID_CHAR and
  // turns a download into a 500.
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy?.());
  stream.pipe(res);
});

router.put('/:id/files/content', editJson, async (req, res) => {
  res.json(await files.write(instance(req), req.user, req.body?.path, req.body?.text));
});

router.post('/:id/files/upload', uploadJson, async (req, res) => {
  res.json(await files.upload(instance(req), req.user, req.body?.path, req.body?.files));
});

router.post('/:id/files/mkdir', express.json(), async (req, res) => {
  res.json(await files.mkdir(instance(req), req.user, req.body?.path, req.body?.name));
});

router.post('/:id/files/touch', express.json(), async (req, res) => {
  res.json(await files.touch(instance(req), req.user, req.body?.path, req.body?.name));
});

router.post('/:id/files/rename', express.json(), async (req, res) => {
  res.json(await files.rename(instance(req), req.user, req.body?.path, req.body?.name));
});

router.delete('/:id/files', async (req, res) => {
  res.json(await files.remove(instance(req), req.user, req.query.path));
});
