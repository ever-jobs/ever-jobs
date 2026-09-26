import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CompensationInterval,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobType,
} from '@ever-jobs/models';
import {
  cardPostedTime,
  cardToJobPost,
  parseCompanyPage,
  parseJobDetail,
  parseSearchCards,
} from '../src/linkedin.parser';

/** Spec 1701 — pure parsing of the guest search, job view and company pages. */

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const FETCHED_AT = Date.parse('2026-09-24T20:00:03Z');
const NO_LEGACY = { ids: false, pay: false, remote: false };

describe('parseSearchCards', () => {
  it('counts every card, including the one with no id', () => {
    const page = parseSearchCards(fixture('search-page-10.html'));
    expect(page.cardCount).toBe(10);
    expect(page.cards).toHaveLength(10);
    expect(page.cards.map((c) => c.jobId)).toEqual([
      '1000000001',
      '1000000002',
      '1000000003',
      '1000000004',
      '1000000005', // no urn: taken from the href
      '1000000006',
      '1000000007',
      '1000000008',
      '1000000009',
      null, // no id anywhere
    ]);
  });

  it('reads the card fields, whitespace collapsed and entities decoded', () => {
    const [first, second, third] = parseSearchCards(fixture('search-page-10.html')).cards;
    expect(first).toMatchObject({
      title: 'Senior Robotics Engineer – Controls',
      companyName: 'Acme Robotics',
      companyHref: 'https://ca.linkedin.com/company/acme-robotics?trk=public_jobs_jserp-result_job-search-card-subtitle',
      locationText: 'Seattle, WA',
      timeDatetime: '2026-09-12',
      timeText: '1 week ago',
      salaryText: null,
    });
    expect(first.companyLogo).toBe(
      'https://media.licdn.com/dms/image/v2/FAKE1/company-logo_100_100/0/1/acme_robotics_logo?e=2147483647&v=beta&t=tok1',
    );
    expect(second.salaryText).toBe('$53,000.00/yr - $65,000.00/yr');
    expect(third.companyLogo).toBeNull(); // ghost placeholder only
  });

  it('an empty fragment has no cards', () => {
    expect(parseSearchCards(fixture('search-page-empty.html'))).toEqual({ cardCount: 0, cards: [] });
    expect(parseSearchCards('')).toEqual({ cardCount: 0, cards: [] });
  });

  it('parses the posted-time fixture (7 cards, one without <time>)', () => {
    const page = parseSearchCards(fixture('linkedin-search-cards.html'));
    expect(page.cardCount).toBe(7);
    expect(page.cards[6]).toMatchObject({ timeDatetime: null, timeText: null });
    expect(page.cards[0].timeText).toBe('26 minutes ago');
  });
});

describe('cardToJobPost', () => {
  const cards = () => parseSearchCards(fixture('search-page-10.html')).cards;

  it('builds a numeric id and the canonical job URL (regression: not the percent-encoded slug)', () => {
    const job = cardToJobPost(cards()[0], {}, FETCHED_AT, NO_LEGACY)!;
    expect(job.id).toBe('li-1000000001');
    expect(job.jobUrl).toBe('https://www.linkedin.com/jobs/view/1000000001');
    expect(job.companyUrl).toBe('https://www.linkedin.com/company/acme-robotics');
    expect(job.site).toBe('linkedin');
  });

  it('skips a card with no id', () => {
    expect(cardToJobPost(cards()[9], {}, FETCHED_AT, NO_LEGACY)).toBeNull();
  });

  it('legacy ids keep the slug id, slug URL and company URL as served', () => {
    const job = cardToJobPost(cards()[0], {}, FETCHED_AT, { ...NO_LEGACY, ids: true })!;
    expect(job.id).toBe('li-senior-robotics-engineer-%E2%80%93-controls-at-acme-robotics-1000000001');
    expect(job.jobUrl).toBe(
      'https://www.linkedin.com/jobs/view/senior-robotics-engineer-%E2%80%93-controls-at-acme-robotics-1000000001',
    );
    expect(job.companyUrl).toBe('https://ca.linkedin.com/company/acme-robotics?trk=public_jobs_jserp-result_job-search-card-subtitle');
    // the no-id card still has a link, so legacy ids keep it
    expect(cardToJobPost(cards()[9], {}, FETCHED_AT, { ...NO_LEGACY, ids: true })!.id).toBe('li-mystery-role');
  });

  it('parses the card pay; legacy pay keeps the old regex', () => {
    const job = cardToJobPost(cards()[1], {}, FETCHED_AT, NO_LEGACY)!;
    expect(job.compensation).toMatchObject({
      minAmount: 53000,
      maxAmount: 65000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
    expect(cardToJobPost(cards()[1], {}, FETCHED_AT, { ...NO_LEGACY, pay: true })!.compensation).toBeNull();
    expect(cardToJobPost(cards()[0], {}, FETCHED_AT, NO_LEGACY)!.compensation).toBeNull();
  });

  it('sets companyLogo only from media.licdn.com', () => {
    expect(cardToJobPost(cards()[0], {}, FETCHED_AT, NO_LEGACY)!.companyLogo).toMatch(/^https:\/\/media\.licdn\.com\//);
    expect('companyLogo' in cardToJobPost(cards()[2], {}, FETCHED_AT, NO_LEGACY)!).toBe(false);
  });

  it('stamps remote from the isRemote filter we sent', () => {
    const job = cardToJobPost(cards()[0], { isRemote: true }, FETCHED_AT, NO_LEGACY)!;
    expect(job.isRemote).toBe(true);
    expect(job.workFromHomeType).toBe('Remote');
  });

  it('without the filter, remote comes from the title and location words only', () => {
    const [seattle, , sensing, , , remote] = cards();
    expect(cardToJobPost(seattle, {}, FETCHED_AT, NO_LEGACY)!.isRemote).toBe(false);
    expect(cardToJobPost(sensing, {}, FETCHED_AT, NO_LEGACY)!.isRemote).toBe(false);
    expect(cardToJobPost(remote, {}, FETCHED_AT, NO_LEGACY)!.isRemote).toBe(true);
  });

  it('legacy remote keeps the substring test and ignores the filter', () => {
    const [seattle, , sensing] = cards();
    expect(cardToJobPost(sensing, {}, FETCHED_AT, { ...NO_LEGACY, remote: true })!.isRemote).toBe(true);
    const stamped = cardToJobPost(seattle, { isRemote: true }, FETCHED_AT, { ...NO_LEGACY, remote: true })!;
    expect(stamped.isRemote).toBe(false);
    expect('workFromHomeType' in stamped).toBe(false);
  });
});

describe('cardPostedTime (Spec 1696 on the search card)', () => {
  const cards = parseSearchCards(fixture('linkedin-search-cards.html')).cards;
  const posted = cards.map((card) => cardPostedTime(card, FETCHED_AT));

  it('sub-day labels become minute/hour instants', () => {
    expect(posted[0]).toEqual({
      datePosted: '2026-09-24',
      datePostedAt: '2026-09-24T19:34:00.000Z',
      datePostedPrecision: DatePostedPrecision.MINUTE,
      datePostedBasis: DatePostedBasis.RELATIVE,
    });
    expect(posted[1]).toMatchObject({
      datePostedAt: '2026-09-24T19:00:00.000Z',
      datePostedPrecision: DatePostedPrecision.HOUR,
    });
  });

  it('a day or week label never overrides the date attribute', () => {
    expect(posted[2]).toMatchObject({ datePosted: '2026-09-22', datePostedAt: null, datePostedPrecision: DatePostedPrecision.DAY });
    expect(posted[3]).toMatchObject({ datePosted: '2026-09-12', datePostedAt: null, datePostedBasis: DatePostedBasis.DATE });
  });

  it('localised and inconsistent labels fall back to the attribute; no <time> gives nothing', () => {
    expect(posted[4]).toMatchObject({ datePosted: '2026-09-24', datePostedAt: null });
    expect(posted[5]).toMatchObject({ datePosted: '2026-09-20', datePostedAt: null });
    expect(posted[6]).toEqual({ datePosted: null, datePostedAt: null, datePostedPrecision: null, datePostedBasis: null });
  });

  it('datePosted equals the attribute for every card that has one', () => {
    cards.forEach((card, i) => {
      if (card.timeDatetime) expect(posted[i].datePosted).toBe(card.timeDatetime);
    });
  });

  it('an attribute the helper cannot use is still passed through as before', () => {
    expect(cardPostedTime({ timeDatetime: '2026-02-30', timeText: '1 hour ago' }, FETCHED_AT)).toEqual({
      datePosted: '2026-02-30',
      datePostedAt: null,
      datePostedPrecision: null,
      datePostedBasis: null,
    });
  });
});

describe('parseJobDetail', () => {
  it.each([DescriptionFormat.MARKDOWN, DescriptionFormat.HTML, DescriptionFormat.PLAIN, undefined])(
    'the %s description has no "Show more" / "Show less" button text',
    (format) => {
      const detail = parseJobDetail(fixture('job-view.html'), format);
      expect(detail.description).toBeTruthy();
      expect(detail.description).toContain('warehouse robots');
      expect(detail.description).not.toMatch(/Show more|Show less/);
    },
  );

  it('reads the criteria by label (regression: jobType only from Employment type)', () => {
    const detail = parseJobDetail(fixture('job-view.html'), DescriptionFormat.MARKDOWN);
    expect(detail.jobType).toEqual([JobType.FULL_TIME]);
    expect(detail.jobLevel).toBe('Internship');
    expect(detail.jobFunction).toBe('Other');
    expect(detail.companyIndustry).toBe('Robotics Engineering');
  });

  it('reads the company id, applicants and top-card logo', () => {
    const detail = parseJobDetail(fixture('job-view.html'));
    expect(detail.companySourceId).toBe('12345');
    expect(detail.applicants).toEqual({ count: 25, bound: 'max' });
    expect(detail.companyLogo).toBe(
      'https://media.licdn.com/dms/image/v2/FAKETOP1/company-logo_100_100/0/1/acme_robotics_logo?e=2147483647&v=beta&t=top1',
    );
    expect(detail.jobUrlDirect).toBeNull();
  });

  it('never reads the similar-jobs pay (negative control)', () => {
    const detail = parseJobDetail(fixture('job-view.html'));
    expect(detail.compensation).toBeNull();
  });

  it('reads the base-pay block, "Over 200", the apply URL, and rejects a non-numeric companyId', () => {
    const detail = parseJobDetail(fixture('job-view-with-pay.html'), DescriptionFormat.MARKDOWN);
    expect(detail.compensation).toMatchObject({
      minAmount: 155000,
      maxAmount: 160000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
    expect(detail.applicants).toEqual({ count: 200, bound: 'min' });
    expect(detail.companySourceId).toBeNull();
    expect(detail.jobUrlDirect).toBe('https://careers.globex.example/jobs/42');
    expect(detail.jobLevel).toBeNull(); // "Not Applicable"
    expect(detail.jobType).toEqual([JobType.CONTRACT]);
  });

  it('reads the JSON-LD posting instant when present', () => {
    expect(parseJobDetail(fixture('job-view-with-pay.html')).posted).toEqual({
      datePosted: '2026-09-24',
      datePostedAt: '2026-09-24T19:12:45.000Z',
      datePostedPrecision: DatePostedPrecision.EXACT,
      datePostedBasis: DatePostedBasis.TIMESTAMP,
    });
    expect(parseJobDetail(fixture('job-view.html')).posted.datePostedAt).toBeNull();
  });

  it('falls back to .description__text without its buttons when the markup div is missing', () => {
    const html = `<div class="decorated-job-posting__details"><div class="description__text"><p>Plain body</p>
      <button class="show-more-less-html__button">Show more</button></div></div>`;
    const detail = parseJobDetail(html, DescriptionFormat.PLAIN);
    expect(detail.description).toContain('Plain body');
    expect(detail.description).not.toContain('Show more');
  });

  it('a page with no description block gives a null description but keeps the other fields', () => {
    const html = `<head><meta name="companyId" content="777"></head><body><section class="top-card-layout">
      <span class="num-applicants__caption">154 applicants</span></section></body>`;
    const detail = parseJobDetail(html);
    expect(detail.description).toBeNull();
    expect(detail.companySourceId).toBe('777');
    expect(detail.applicants).toEqual({ count: 154, bound: 'exact' });
  });

  it('never takes a face-pile photo as the company logo', () => {
    const html = `<section class="top-card-layout"><img class="artdeco-entity-image" data-delayed-url="https://static.licdn.com/aero-v1/sc/h/ghost">
      <img class="face-pile__image" data-delayed-url="https://media.licdn.com/dms/image/v2/P/profile-displayphoto-shrink_100_100/0/1/p"></section>`;
    expect(parseJobDetail(html).companyLogo).toBeNull();
  });

  it('legacy detail keeps the old selector and criteria reads', () => {
    const detail = parseJobDetail(fixture('job-view.html'), DescriptionFormat.MARKDOWN, { legacyDetail: true });
    expect(detail.description).toMatch(/Show more/);
    expect(detail.jobType).toEqual(expect.arrayContaining([JobType.INTERNSHIP, JobType.FULL_TIME, JobType.OTHER]));
    const pay = parseJobDetail(fixture('job-view-with-pay.html'), undefined, { legacyDetail: true });
    expect(pay.jobLevel).toBe('Not Applicable');
  });

  it('legacy pay does not read the base-pay block', () => {
    expect(parseJobDetail(fixture('job-view-with-pay.html'), undefined, { legacyPay: true }).compensation).toBeNull();
  });

  it('never throws on empty or junk input', () => {
    expect(() => parseJobDetail('')).not.toThrow();
    expect(parseJobDetail('').description).toBeNull();
    expect(() => parseJobDetail(undefined as unknown as string)).not.toThrow();
  });
});

describe('parseCompanyPage', () => {
  it('takes the Organization node (not @graph[0]) and prefers the size band', () => {
    expect(parseCompanyPage(fixture('company-page.html'))).toEqual({
      website: 'http://acme.example',
      address: '100 Example Way, Seattle, WA 98101, US',
      employeesLd: '1234',
      sizeBand: '1,001-5,000',
      industry: 'Robotics Engineering',
      description: 'Acme Robotics builds warehouse robots.',
      logo: 'https://media.licdn.com/dms/image/v2/FAKEORG1/company-logo_200_200/0/1/acme_robotics_logo?e=2147483647&v=beta&t=org1',
    });
  });

  it('falls back to the About-us list when there is no JSON-LD (redirect unwrapped)', () => {
    expect(parseCompanyPage(fixture('company-page-dom-only.html'))).toEqual({
      website: 'https://www.globex.example/',
      address: 'Warren, MI',
      employeesLd: null,
      sizeBand: '51-200',
      industry: 'Software Development',
      description: 'Globex moves data at planetary scale.',
      logo: null,
    });
  });

  it('ignores a linkedin.com sameAs and a placeholder logo', () => {
    const details = parseCompanyPage(fixture('company-page-sameas-linkedin.html'))!;
    expect(details.website).toBe('http://initech.example');
    expect(details.employeesLd).toBe('87');
    expect(details.logo).toBeNull();
  });

  it('returns null when the page yields nothing', () => {
    expect(parseCompanyPage('<html><body>authwall</body></html>')).toBeNull();
    expect(parseCompanyPage('')).toBeNull();
  });
});
