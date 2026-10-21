export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT = /pass|secret|token|authorization|cookie|email|key|signature|receipt|credential/i;

export type LogFields = Record<string, unknown>;

/** Replace the value of any field whose name looks sensitive. Applied recursively. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

type Sink = (line: string) => void;

export function createLogger(opts: { level?: LogLevel; base?: LogFields; sink?: Sink } = {}): Logger {
  const level = opts.level ?? 'info';
  const base = opts.base ?? {};
  const sink: Sink = opts.sink ?? ((line) => console.log(line));
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(
      JSON.stringify({
        level: lvl,
        msg,
        ...(redact({ ...base, ...fields }) as LogFields),
        ts: new Date().toISOString(),
      }),
    );
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, sink }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });
