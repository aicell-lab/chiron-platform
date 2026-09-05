/**
 * Platform-wide logging with a bounded in-memory buffer.
 *
 * Two things happen here that are easy to conflate, so they are kept separate:
 *
 *   printing   what reaches the devtools console. Defaults to `debug` and can
 *              be turned down at build time, per browser, or at runtime.
 *   capturing  what goes into the ring buffer that a problem report attaches.
 *              Always `debug`, unconditionally. A report must not come back
 *              thin just because the reporter had a quiet console configured.
 *
 * The buffer is what makes the Report Issue button worth having. A user who
 * hits a bug cannot be expected to reconstruct what the page was doing, and
 * until now the evidence was written to a console that vanished with the tab.
 *
 * Nothing here is persisted. The buffer lives for the lifetime of the page.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Epoch milliseconds. */
  t: number;
  level: LogLevel;
  /** Module or component the line came from. Intercepted console calls use `console`. */
  source: string;
  msg: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Entries are dropped oldest-first once either bound is hit. */
const MAX_ENTRIES = 500;
const MAX_BUFFER_BYTES = 256 * 1024;
/** A single argument that stringifies to more than this is truncated. */
const MAX_ARG_CHARS = 2000;
/** A whole line is truncated to this after joining its arguments. */
const MAX_LINE_CHARS = 4000;

const buffer: LogEntry[] = [];
let bufferBytes = 0;

/**
 * Captured before anything else can wrap them. Every write from this module
 * goes through these, never through `console.*`, so the interceptor installed
 * below cannot recurse into itself.
 */
const nativeConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function parseLevel(value: string | null | undefined): LogLevel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized in LEVEL_ORDER ? (normalized as LogLevel) : null;
}

function readInitialPrintLevel(): LogLevel {
  // Per-browser override wins, so a maintainer can quieten a noisy tab without
  // a rebuild. Reading localStorage can throw outright in a sandboxed iframe or
  // with site data blocked, which must not take the whole logger down with it.
  try {
    const stored = parseLevel(window.localStorage.getItem('chironLogLevel'));
    if (stored) return stored;
  } catch {
    // Storage unavailable. Fall through to the build-time default.
  }
  return parseLevel(process.env.REACT_APP_LOG_LEVEL) || 'debug';
}

let printLevel: LogLevel = readInitialPrintLevel();

/** Circular-safe, Error-aware stringify for one logged argument. */
function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
  }
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg !== 'object') return String(arg);
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(arg, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      return value;
    }) ?? String(arg);
  } catch {
    // Getters that throw, proxies, host objects. Something is better than
    // losing the line, so fall back to whatever coercion yields.
    try {
      return String(arg);
    } catch {
      return '[unserializable]';
    }
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [${text.length - limit} more characters]`;
}

function formatArgs(args: unknown[]): string {
  return truncate(
    args.map((arg) => truncate(stringifyArg(arg), MAX_ARG_CHARS)).join(' '),
    MAX_LINE_CHARS
  );
}

function push(level: LogLevel, source: string, msg: string): void {
  const entry: LogEntry = { t: Date.now(), level, source, msg };
  buffer.push(entry);
  bufferBytes += msg.length + source.length;
  while (buffer.length > MAX_ENTRIES || bufferBytes > MAX_BUFFER_BYTES) {
    const dropped = buffer.shift();
    if (!dropped) break;
    bufferBytes -= dropped.msg.length + dropped.source.length;
  }
}

/* ------------------------------------------------------------------ *
 * Redaction
 *
 * Runs on the way out of the browser, not on the way into the buffer, so
 * the devtools console a developer is watching stays complete and readable.
 * Every rule here exists because the value it removes has actually appeared
 * in our own console output at some point.
 * ------------------------------------------------------------------ */

const REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  // JWTs. Hypha tokens are logged by several call sites during connect and
  // refresh, and one of them is enough to act as the user who reported.
  {
    pattern: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g,
    replacement: '[redacted-jwt]',
  },
  // Authorization headers, whatever the token format.
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1[redacted]' },
  // Credentials that ride in a query string, including presigned upload URLs.
  {
    pattern: /([?&](?:access_token|token|api_key|apikey|signature|x-amz-signature)=)[^&\s"']+/gi,
    replacement: '$1[redacted]',
  },
  // Absolute filesystem paths. A reporter's own paths are not ours to collect,
  // and the platform never needs them to explain a browser-side failure.
  // The leading group keeps a URL path such as `https://host/data/x` intact:
  // only a path that starts a token is a filesystem path.
  {
    pattern: /(^|[^\w/])((?:\/home|\/data|\/Users|\/mnt|\/media)\/[^\s"'`,;)\]}]*)/g,
    replacement: '$1[redacted-path]',
  },
  { pattern: /\b[A-Za-z]:\\[^\s"'`,;)\]}]*/g, replacement: '[redacted-path]' },
];

function redact(text: string): string {
  return REDACTIONS.reduce(
    (acc, { pattern, replacement }) => acc.replace(pattern, replacement),
    text
  );
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function write(level: LogLevel, source: string, args: unknown[]): void {
  const msg = formatArgs(args);
  push(level, source, msg);
  if (LEVEL_ORDER[level] < LEVEL_ORDER[printLevel]) return;
  const prefix = `[${source}]`;
  if (level === 'error') nativeConsole.error(prefix, ...args);
  else if (level === 'warn') nativeConsole.warn(prefix, ...args);
  else if (level === 'info') nativeConsole.info(prefix, ...args);
  else nativeConsole.debug(prefix, ...args);
}

export const logger = {
  debug: (source: string, ...args: unknown[]) => write('debug', source, args),
  info: (source: string, ...args: unknown[]) => write('info', source, args),
  warn: (source: string, ...args: unknown[]) => write('warn', source, args),
  error: (source: string, ...args: unknown[]) => write('error', source, args),

  /** The level that reaches the console. Capture is always `debug`. */
  getLevel: (): LogLevel => printLevel,

  setLevel: (level: LogLevel): void => {
    if (!(level in LEVEL_ORDER)) {
      nativeConsole.warn(`[logger] Ignoring unknown log level '${level}'.`);
      return;
    }
    printLevel = level;
    try {
      window.localStorage.setItem('chironLogLevel', level);
    } catch {
      // Not persistable in this browser. The level still applies to this tab.
    }
  },

  /**
   * A redacted copy of the buffer, oldest first. This is what leaves the
   * browser in a problem report, and it is what the dialog shows the reporter
   * before they decide to send it.
   */
  snapshot: (): LogEntry[] =>
    buffer.map((entry) => ({ ...entry, msg: redact(entry.msg) })),

  clear: (): void => {
    buffer.length = 0;
    bufferBytes = 0;
  },
};

/* ------------------------------------------------------------------ *
 * Console interceptor
 * ------------------------------------------------------------------ */

let interceptorInstalled = false;

/**
 * Route the existing `console.*` calls scattered across the app into the
 * buffer without rewriting them.
 *
 * There are several hundred of them. Migrating every one to `logger.*` would
 * be a large diff that touches almost every file and would still miss the
 * calls made by our dependencies, which are often the most informative lines
 * in a report. Wrapping the console captures all of it at once. The original
 * functions are called through unchanged, so devtools output is identical and
 * stack traces still point at the real call site.
 */
export function installConsoleInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const wrap = (
    method: keyof typeof nativeConsole,
    level: LogLevel
  ): ((...args: unknown[]) => void) => (...args: unknown[]) => {
      // Capture must never break the app that is logging. A logger that can
      // throw turns a cosmetic bug into a blank page.
      try {
        push(level, 'console', formatArgs(args));
      } catch {
        // Give up on this line only.
      }
      nativeConsole[method](...args);
    };

  console.log = wrap('log', 'debug');
  console.debug = wrap('debug', 'debug');
  console.info = wrap('info', 'info');
  console.warn = wrap('warn', 'warn');
  console.error = wrap('error', 'error');

  // A handle for debugging from the devtools console of a deployed build.
  (window as unknown as Record<string, unknown>).chironLogger = logger;
}

export default logger;
