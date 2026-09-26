import { parseRobotsTxt, robotsAllows } from '../src/simplifyjobs.robots';

const FEED_PATH = '/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json';

describe('robots.txt (Spec 1694)', () => {
  it('allows everything when there are no rules (404 or empty file)', () => {
    expect(robotsAllows([], FEED_PATH)).toBe(true);
    expect(robotsAllows(parseRobotsTxt('', 'everjobs'), FEED_PATH)).toBe(true);
  });

  it('applies the * group when no group names us', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /SimplifyJobs/\n', 'everjobs');
    expect(robotsAllows(rules, FEED_PATH)).toBe(false);
    expect(robotsAllows(rules, '/other/repo/dev/file.json')).toBe(true);
  });

  it('prefers the group naming our product token, case-insensitively, over *', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: EverJobs/1.0',
      'Allow: /',
    ].join('\n');
    expect(robotsAllows(parseRobotsTxt(text, 'everjobs'), FEED_PATH)).toBe(true);
    expect(robotsAllows(parseRobotsTxt(text, 'otherbot'), FEED_PATH)).toBe(false);
  });

  it('merges consecutive user-agent lines into one group', () => {
    const text = 'User-agent: somebot\nUser-agent: everjobs\nDisallow: /SimplifyJobs\n\nUser-agent: *\nAllow: /\n';
    expect(robotsAllows(parseRobotsTxt(text, 'everjobs'), FEED_PATH)).toBe(false);
  });

  it('lets the longest matching rule win, and allow win a tie', () => {
    const text = [
      'User-agent: *',
      'Disallow: /SimplifyJobs/',
      'Allow: /SimplifyJobs/New-Grad-Positions/',
      'Disallow: /tie',
      'Allow: /tie',
    ].join('\n');
    const rules = parseRobotsTxt(text, 'everjobs');
    expect(robotsAllows(rules, FEED_PATH)).toBe(true);
    expect(robotsAllows(rules, '/SimplifyJobs/Summer2027-Internships/dev/x.json')).toBe(false);
    expect(robotsAllows(rules, '/tie/x')).toBe(true);
  });

  it('supports * wildcards and the $ end anchor', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /*/listings.json$\nDisallow: /*.zip\n', 'everjobs');
    expect(robotsAllows(rules, FEED_PATH)).toBe(false);
    expect(robotsAllows(rules, `${FEED_PATH}.bak`)).toBe(true);
    expect(robotsAllows(rules, '/a/b/archive.zip?x=1')).toBe(false);
  });

  it('ignores comments, unknown keys, an empty Disallow and rules before any group', () => {
    const text = [
      'Disallow: /orphan',
      '# comment',
      'Sitemap: https://example.com/sitemap.xml',
      'User-agent: * # everyone',
      'Crawl-delay: 5',
      'Disallow:',
      'Disallow: /private # trailing comment',
    ].join('\r\n');
    const rules = parseRobotsTxt(text, 'everjobs');
    expect(rules).toEqual([{ allow: false, pattern: '/private' }]);
    expect(robotsAllows(rules, '/orphan/x')).toBe(true);
  });

  it('always allows /robots.txt itself', () => {
    expect(robotsAllows(parseRobotsTxt('User-agent: *\nDisallow: /\n', 'everjobs'), '/robots.txt')).toBe(true);
  });
});
