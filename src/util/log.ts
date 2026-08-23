type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env.SIFT_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = ORDER[envLevel] ?? ORDER.info;

function inspect(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 19);
  const tag = { debug: 'dbg', info: 'inf', warn: 'WRN', error: 'ERR' }[level];
  const line = `${ts} ${tag} [${scope}] ${msg}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, typeof extra === 'string' ? extra : inspect(extra));
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(sub: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => logger(`${scope}:${sub}`),
  };
}
