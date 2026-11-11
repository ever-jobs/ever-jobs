import { canonicalJobUrl, dropDuplicateJobUrls, JOB_URL_DUPLICATE_REASON } from '@ever-jobs/common';

/** Spec 1754 — canonical job URL and first-seen-wins duplicate skipping. */
describe('canonicalJobUrl (Spec 1754)', () => {
  it('strips utm_* and click-id tracking parameters', () => {
    expect(
      canonicalJobUrl('https://boards.example.com/acme/jobs/42?utm_source=x&UTM_Medium=y&gclid=1&fbclid=2&gh_src=abc'),
    ).toBe('https://boards.example.com/acme/jobs/42');
  });

  it('lower-cases the host and drops a default port', () => {
    expect(canonicalJobUrl('HTTPS://Boards.Example.COM:443/Acme/Jobs/42')).toBe(
      'https://boards.example.com/Acme/Jobs/42',
    );
  });

  it('keeps functional parameters and sorts them so order does not matter', () => {
    const a = canonicalJobUrl('https://example.com/job?gh_jid=7&utm_source=x&b=2');
    const b = canonicalJobUrl('https://example.com/job?b=2&gh_jid=7');
    expect(a).toBe('https://example.com/job?b=2&gh_jid=7');
    expect(b).toBe(a);
  });

  it('keeps the path case and the fragment (hash-routed boards)', () => {
    expect(canonicalJobUrl('https://example.com/Jobs#/posting/9?utm_source=x')).toBe(
      'https://example.com/Jobs#/posting/9?utm_source=x',
    );
  });

  it('keeps a lookalike parameter that is not tracking', () => {
    expect(canonicalJobUrl('https://example.com/job?source=board&ref=12')).toBe(
      'https://example.com/job?ref=12&source=board',
    );
  });

  it('returns null for unusable input', () => {
    for (const value of [undefined, null, '', '   ', 'not a url', '/relative/path', 'ftp://example.com/x', 'javascript:alert(1)']) {
      expect(canonicalJobUrl(value)).toBeNull();
    }
    expect(canonicalJobUrl(`https://example.com/${'a'.repeat(5000)}`)).toBeNull();
  });
});

describe('dropDuplicateJobUrls (Spec 1754)', () => {
  const post = (id: string, jobUrl: string | undefined, title = 'Backend Engineer') => ({ id, jobUrl, title });

  it('keeps the first posting and skips later ones with the same canonical URL', async () => {
    const jobs = [
      post('a', 'https://Example.com/jobs/1?utm_source=feed'),
      post('b', 'https://example.com/jobs/1?utm_campaign=mail'),
      post('c', 'https://example.com/jobs/2'),
      post('d', 'https://example.com/jobs/1'),
    ];
    const { jobs: kept, skipped } = await dropDuplicateJobUrls(jobs);
    expect(kept.map((j) => j.id)).toEqual(['a', 'c']);
    expect(skipped).toEqual([
      { index: 1, firstIndex: 0, canonicalUrl: 'https://example.com/jobs/1', reason: JOB_URL_DUPLICATE_REASON },
      { index: 3, firstIndex: 0, canonicalUrl: 'https://example.com/jobs/1', reason: JOB_URL_DUPLICATE_REASON },
    ]);
  });

  it('keeps the original objects and does not modify the input', async () => {
    const jobs = [post('a', 'https://example.com/j/1'), post('b', 'https://example.com/j/1')];
    const snapshot = [...jobs];
    const { jobs: kept } = await dropDuplicateJobUrls(jobs);
    expect(kept[0]).toBe(jobs[0]);
    expect(jobs).toEqual(snapshot);
  });

  it('keeps every posting that has no usable URL', async () => {
    const jobs = [post('a', undefined), post('b', undefined), post('c', 'nonsense'), post('d', 'nonsense')];
    const { jobs: kept, skipped } = await dropDuplicateJobUrls(jobs);
    expect(kept).toHaveLength(4);
    expect(skipped).toEqual([]);
  });

  it('keeps different roles that share one listing URL', async () => {
    const jobs = [
      post('a', 'https://example.com/careers', 'Backend Engineer'),
      post('b', 'https://example.com/careers', 'Product Designer'),
      post('c', 'https://example.com/careers', '  backend   ENGINEER '),
    ];
    const { jobs: kept, skipped } = await dropDuplicateJobUrls(jobs);
    expect(kept.map((j) => j.id)).toEqual(['a', 'b']);
    expect(skipped.map((s) => s.index)).toEqual([2]);
  });

  it('keeps postings whose URLs differ only in a functional parameter', async () => {
    const { jobs: kept } = await dropDuplicateJobUrls([
      post('a', 'https://example.com/job?gh_jid=1'),
      post('b', 'https://example.com/job?gh_jid=2'),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('handles an empty list', async () => {
    expect(await dropDuplicateJobUrls([])).toEqual({ jobs: [], skipped: [] });
  });

  it('uses a custom roleKey, and keeps a posting whose roleKey is undefined', async () => {
    const jobs = [
      { id: 'a', jobUrl: 'https://example.com/careers', title: 'Engineer', city: 'Austin' },
      { id: 'b', jobUrl: 'https://example.com/careers', title: 'Engineer', city: 'Berlin' },
      { id: 'c', jobUrl: 'https://example.com/careers', title: 'Engineer', city: 'Austin' },
      { id: 'd', jobUrl: 'https://example.com/careers', title: 'Engineer', city: '' },
      { id: 'e', jobUrl: 'https://example.com/careers', title: 'Engineer', city: '' },
    ];
    const { jobs: kept } = await dropDuplicateJobUrls(jobs, { roleKey: (j) => j.city || undefined });
    expect(kept.map((j) => j.id)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('never skips or remembers a posting the keep predicate claims', async () => {
    const jobs = [post('a', 'https://example.com/j/1'), post('b', 'https://example.com/j/1'), post('c', 'https://example.com/j/1')];
    const { jobs: kept, skipped } = await dropDuplicateJobUrls(jobs, { keep: (j) => j.id === 'a' || j.id === 'b' });
    // a and b are kept untouched; c becomes the first it knows of and is kept too.
    expect(kept.map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(skipped).toEqual([]);
  });

  it('lets other work run during a large list and still skips correctly', async () => {
    const jobs = Array.from({ length: 1500 }, (_v, i) => post(`j${i}`, `https://example.com/j/${i % 1000}`));
    let otherWorkRan = false;
    setImmediate(() => {
      otherWorkRan = true;
    });
    const pending = dropDuplicateJobUrls(jobs);
    // Nothing has run to completion synchronously: the callback above can only fire mid-pass.
    const { jobs: kept, skipped } = await pending;
    expect(otherWorkRan).toBe(true);
    expect(kept).toHaveLength(1000);
    expect(skipped).toHaveLength(500);
  });
});
