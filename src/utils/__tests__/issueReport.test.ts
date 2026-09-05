import { buildIssueAlias } from '../issueReport';

/**
 * The alias is the id a maintainer reads out of a channel notification and
 * types into a script, so its shape is a contract rather than an
 * implementation detail.
 */
describe('buildIssueAlias', () => {
  test('renders the submission time in UTC, not in the local zone', () => {
    // 22:11:13Z. Any zone-aware formatting would shift this by hours.
    const alias = buildIssueAlias('2026-08-30T22:11:13.201Z');
    expect(alias).toMatch(/^issue-20260830-221113-[a-z0-9]{6}$/);
  });

  test('zero pads every field', () => {
    const alias = buildIssueAlias('2026-01-02T03:04:05.000Z');
    expect(alias.startsWith('issue-20260102-030405-')).toBe(true);
  });

  test('varies the suffix so two reports in the same second do not collide', () => {
    const at = '2026-08-30T22:11:13.201Z';
    const aliases = new Set(Array.from({ length: 200 }, () => buildIssueAlias(at)));
    expect(aliases.size).toBeGreaterThan(190);
  });
});
