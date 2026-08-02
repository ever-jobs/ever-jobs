import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  CompensationInterval,
  DescriptionFormat,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { GreenhouseModule, GreenhouseService } from '../src';
import { GREENHOUSE_API_URL } from '../src/greenhouse.constants';
import { GreenhouseJob } from '../src/greenhouse.types';

const SLUG = 'acme';
const EXPECTED_URL = `${GREENHOUSE_API_URL}/${SLUG}/jobs?content=true`;

/**
 * Spec 5009 — entity-encoded content, location parsing, and metadata mapping.
 *
 * Drives the public board path with a mocked HTTP client so each fix is
 * asserted against a single crafted job payload.
 */
describe('GreenhouseService — Spec 5009', () => {
  let service: GreenhouseService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GreenhouseModule],
    }).compile();
    service = moduleRef.get(GreenhouseService);
  });

  beforeEach(() => {
    mockGet.mockReset();
    delete process.env.GREENHOUSE_API_KEY;
  });

  async function scrapeOne(
    job: GreenhouseJob,
    format = DescriptionFormat.MARKDOWN,
  ) {
    mockGet.mockResolvedValueOnce({ data: { jobs: [job] } });
    const input = new ScraperInputDto({
      siteType: [Site.GREENHOUSE],
      companySlug: SLUG,
      resultsWanted: 5,
      descriptionFormat: format,
    });
    const response: JobResponseDto = await service.scrape(input);
    expect(mockGet).toHaveBeenCalledWith(EXPECTED_URL);
    expect(response.jobs).toHaveLength(1);
    return response.jobs[0];
  }

  it('decodes entity-encoded content into clean text', async () => {
    const job = await scrapeOne({
      id: 1,
      title: 'Engineer',
      content:
        '&lt;div&gt;&lt;p&gt;Build &amp; ship things.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Rust&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;',
      location: { name: 'Boston, MA' },
    });

    expect(job.description).toContain('Build & ship things.');
    expect(job.description).toContain('Rust');
    expect(job.description).not.toMatch(/<\/?(?:div|p|ul|li)\b/i);
    expect(job.description).not.toContain('&lt;');
  });

  it('leaves real HTML content unchanged (no double-decode of body entities)', async () => {
    const job = await scrapeOne({
      id: 2,
      title: 'Engineer',
      content: '<p>Use when a &lt; b returns true.</p>',
      location: { name: 'Boston, MA' },
    });

    // The literal `&lt;` in body text must survive as a "<" character, not be
    // treated as a tag and stripped.
    expect(job.description).toContain('a < b returns true.');
  });

  it('parses a multi-site location and infers remote via parseLocationList', async () => {
    const job = await scrapeOne({
      id: 3,
      title: 'Engineer',
      content: '&lt;p&gt;Role&lt;/p&gt;',
      location: { name: 'Santa Clara, CA or Remote' },
    });

    expect(job.location?.city).toBe('Santa Clara');
    expect(job.location?.state).toBe('CA');
    expect(job.isRemote).toBe(true);
  });

  it('joins multiple concrete sites from a single location string', async () => {
    const job = await scrapeOne({
      id: 4,
      title: 'Engineer',
      content: '&lt;p&gt;Role&lt;/p&gt;',
      location: { name: 'Paducah, KY or Los Angeles, CA' },
    });

    expect(job.location?.city).toContain('Paducah, KY');
    expect(job.location?.city).toContain('Los Angeles, CA');
    expect(job.isRemote).toBe(false);
  });

  it('maps currency_range metadata to a yearly compensation and Employment Type', async () => {
    const job = await scrapeOne({
      id: 5,
      title: 'Engineer',
      content: '&lt;p&gt;Role&lt;/p&gt;',
      location: { name: 'Remote' },
      metadata: [
        {
          id: 10,
          name: 'Salary Range',
          value_type: 'currency_range',
          value: { unit: 'USD', min_value: '170000.0', max_value: '220000.0' },
        },
        {
          id: 11,
          name: 'Employment Type',
          value_type: 'single_select',
          value: 'Full-time',
        },
      ],
    });

    expect(job.compensation?.interval).toBe(CompensationInterval.YEARLY);
    expect(job.compensation?.currency).toBe('USD');
    expect(job.compensation?.minAmount).toBe(170000);
    expect(job.compensation?.maxAmount).toBe(220000);
    expect(job.employmentType).toBe('Full-time');
  });

  it('leaves compensation and employmentType null when no metadata', async () => {
    const job = await scrapeOne({
      id: 6,
      title: 'Engineer',
      content: '&lt;p&gt;Role&lt;/p&gt;',
      location: { name: 'Boston, MA' },
    });

    expect(job.compensation).toBeNull();
    expect(job.employmentType).toBeNull();
  });

  it('falls back to the decoded body salary when no currency_range metadata (Spec 5018)', async () => {
    const job = await scrapeOne({
      id: 7,
      title: 'Engineer',
      content:
        '&lt;p&gt;Compensation: $120,000 - $160,000 per year plus equity.&lt;/p&gt;',
      location: { name: 'Boston, MA' },
    });

    expect(job.compensation?.minAmount).toBe(120000);
    expect(job.compensation?.maxAmount).toBe(160000);
    expect(job.compensation?.currency).toBe('USD');
  });

  it('prefers currency_range metadata over a body salary (Spec 5018)', async () => {
    const job = await scrapeOne({
      id: 8,
      title: 'Engineer',
      content: '&lt;p&gt;Body says $10,000 - $20,000 per year.&lt;/p&gt;',
      location: { name: 'Remote' },
      metadata: [
        {
          id: 10,
          name: 'Salary Range',
          value_type: 'currency_range',
          value: { unit: 'USD', min_value: '170000.0', max_value: '220000.0' },
        },
      ],
    });

    expect(job.compensation?.minAmount).toBe(170000);
    expect(job.compensation?.maxAmount).toBe(220000);
  });

  it('keeps datePosted on the source local day for an evening offset timestamp (Spec 5024)', async () => {
    // 2026-04-20T22:32:33-04:00 is 2026-04-21T02:32Z; UTC truncation would
    // report 2026-04-21. The posting's own calendar day is 2026-04-20.
    const job = await scrapeOne({
      id: 9,
      title: 'Engineer',
      content: '&lt;p&gt;Role&lt;/p&gt;',
      location: { name: 'Boston, MA' },
      first_published: '2026-04-20T22:32:33-04:00',
    });

    expect(job.datePosted).toBe('2026-04-20');
  });

  // ── Spec 5027 — structured remote evidence (offices[] + Work Location) ──
  describe('structured remote evidence (Spec 5027)', () => {
    it('flags remote from an office named Remote when the role location is concrete', async () => {
      const job = await scrapeOne({
        id: 20,
        title: 'Engineer',
        content: '&lt;p&gt;Role&lt;/p&gt;',
        location: { name: 'Austin, TX' },
        offices: [{ id: 1, name: 'Remote' }],
      });

      expect(job.isRemote).toBe(true);
      expect(job.workFromHomeType).toBe('Remote');
    });

    it('flags remote from a "Work Location" metadata value of Remote', async () => {
      const job = await scrapeOne({
        id: 21,
        title: 'Engineer',
        content: '&lt;p&gt;Role&lt;/p&gt;',
        location: { name: 'Austin, TX' },
        metadata: [
          { id: 30, name: 'Work Location', value_type: 'single_select', value: 'Remote' },
        ],
      });

      expect(job.isRemote).toBe(true);
      expect(job.workFromHomeType).toBe('Remote');
    });

    it('maps a Hybrid "Work Location" to workFromHomeType without flagging remote', async () => {
      const job = await scrapeOne({
        id: 22,
        title: 'Engineer',
        content: '&lt;p&gt;Role&lt;/p&gt;',
        location: { name: 'Austin, TX' },
        metadata: [
          { id: 31, name: 'Work Location', value_type: 'single_select', value: 'Hybrid' },
        ],
      });

      expect(job.isRemote).toBe(false);
      expect(job.workFromHomeType).toBe('Hybrid');
    });

    it('does not flag remote for a concrete office and non-remote location', async () => {
      const job = await scrapeOne({
        id: 23,
        title: 'Engineer',
        content: '&lt;p&gt;Role&lt;/p&gt;',
        location: { name: 'Austin, TX' },
        offices: [{ id: 2, name: 'Austin', location: 'Austin, TX' }],
        metadata: [
          { id: 32, name: 'Work Location', value_type: 'single_select', value: 'On-site' },
        ],
      });

      expect(job.isRemote).toBe(false);
      expect(job.workFromHomeType).toBeNull();
    });
  });
});
