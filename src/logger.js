import crypto from 'node:crypto';
import { config } from './config.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function configuredLevel() {
  const value = String(config.logLevel || 'info').toLowerCase();
  return Object.hasOwn(LEVELS, value) ? value : 'info';
}

function serialiseError(err) {
  if (!err) return undefined;
  return {
    name: err.name,
    message: err.message,
    ...(err.code ? { code: err.code } : {}),
    ...(err.stack ? { stack: err.stack } : {}),
  };
}

function prettyValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    // Keep short, simple values scannable while escaping whitespace/newlines.
    return /^[\w./:@%+,-]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
}

function prettyLine(payload) {
  const level = String(payload.level || '').toUpperCase().padEnd(5);
  const fields = Object.entries(payload)
    .filter(([key]) => !['ts', 'level', 'event'].includes(key))
    .map(([key, value]) => `${key}=${prettyValue(value)}`)
    .join(' ');
  return `${payload.ts} ${level} ${payload.event}${fields ? `  ${fields}` : ''}`;
}

function write(level, event, fields = {}) {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return;
  const normalisedFields = fields.error instanceof Error
    ? { ...fields, error: serialiseError(fields.error) }
    : fields;
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...normalisedFields,
  };
  const output = config.logFormat === 'json' ? JSON.stringify(payload) : prettyLine(payload);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

export const logger = Object.freeze({
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields = {}) => write('error', event, {
    ...fields,
    ...(fields.error instanceof Error ? { error: serialiseError(fields.error) } : {}),
  }),
});

export function requestLogger(req, res, next) {
  const requestId = crypto.randomUUID();
  const started = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  let completed = false;
  const record = (aborted) => {
    if (completed) return;
    completed = true;
    if (!config.logHttp || (!config.logHttpStatic && !req.path.startsWith('/api'))) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info('http.request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ...(aborted ? { aborted: true } : {}),
      durationMs: Math.round(durationMs * 100) / 100,
      ...(req.user ? { userId: req.user.id, username: req.user.username } : {}),
      ...(req.disabledUser ? { disabledUser: req.disabledUser.username } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
    });
  };
  res.once('finish', () => record(false));
  res.once('close', () => record(!res.writableFinished));
  next();
}

export function logUnhandledErrors() {
  process.on('unhandledRejection', (error) => logger.error('process.unhandledRejection', { error }));
  process.on('uncaughtExceptionMonitor', (error) => logger.error('process.uncaughtException', { error }));
}
