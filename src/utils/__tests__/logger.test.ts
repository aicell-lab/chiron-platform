import { logger } from '../logger';

/**
 * The redaction rules are the only thing standing between a reporter's
 * console and our issues collection, so they get a test that names each
 * secret we have actually seen logged.
 */
describe('logger.snapshot redaction', () => {
  beforeEach(() => {
    logger.clear();
  });

  const snapshotText = () => logger.snapshot().map((entry) => entry.msg).join('\n');

  test('strips JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    logger.info('hyphaStore', `Connected with token ${jwt}`);
    const text = snapshotText();
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('eyJhbGci');
    expect(text).toContain('[redacted-jwt]');
  });

  test('strips Bearer authorization headers', () => {
    logger.debug('hyphaHttp', { Authorization: 'Bearer abcdef0123456789ABCDEF' });
    const text = snapshotText();
    expect(text).not.toContain('abcdef0123456789ABCDEF');
    expect(text).toContain('[redacted]');
  });

  test('strips credentials carried in query strings', () => {
    logger.info(
      'artifactApi',
      'GET https://hypha.aicell.io/chiron-platform/artifacts/x?access_token=s3cr3tvalue&stage=false'
    );
    const text = snapshotText();
    expect(text).not.toContain('s3cr3tvalue');
    // Redaction must stop at the parameter boundary, not swallow the rest.
    expect(text).toContain('stage=false');
  });

  test('strips absolute filesystem paths', () => {
    logger.warn('training', 'dataset at /data/nmechtel/tabula/demo/pbmc.h5ad missing');
    logger.warn('training', 'checkpoint at C:\\Users\\someone\\weights.pt missing');
    const text = snapshotText();
    expect(text).not.toContain('/data/nmechtel');
    expect(text).not.toContain('C:\\Users\\someone');
    expect(text).toContain('[redacted-path]');
    // The surrounding sentence still has to be readable.
    expect(text).toContain('missing');
  });

  test('leaves the buffer itself unredacted so devtools stays complete', () => {
    logger.info('hyphaStore', 'token=abcdef0123456789');
    // snapshot() returns copies; calling it twice must not mutate the source.
    expect(snapshotText()).toEqual(snapshotText());
  });
});

describe('logger buffer', () => {
  beforeEach(() => {
    logger.clear();
  });

  test('drops the oldest entries past the cap rather than growing without bound', () => {
    for (let i = 0; i < 600; i += 1) {
      logger.debug('bulk', `line ${i}`);
    }
    const entries = logger.snapshot();
    expect(entries.length).toBeLessThanOrEqual(500);
    expect(entries[entries.length - 1].msg).toContain('line 599');
    expect(entries[0].msg).not.toContain('line 0 ');
  });

  test('captures at debug regardless of the print level', () => {
    logger.setLevel('error');
    logger.debug('quiet', 'still recorded');
    expect(snapshotHas('still recorded')).toBe(true);
    logger.setLevel('debug');
  });

  test('serialises errors and circular objects without throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => logger.error('boom', new Error('kaboom'), circular)).not.toThrow();
    const text = logger.snapshot().map((e) => e.msg).join('\n');
    expect(text).toContain('kaboom');
    expect(text).toContain('[Circular]');
  });
});

function snapshotHas(needle: string): boolean {
  return logger.snapshot().some((entry) => entry.msg.includes(needle));
}
