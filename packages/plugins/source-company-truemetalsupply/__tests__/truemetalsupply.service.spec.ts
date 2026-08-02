import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';
import {
  TRUEMETALSUPPLY_CAREERS_URL,
  TRUEMETALSUPPLY_COMPANY_NAME,
} from '../src/truemetalsupply.constants';
import { TrueMetalSupplyOpening } from '../src/truemetalsupply.types';
import { TrueMetalSupplyModule, TrueMetalSupplyService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const DIALOGS: TrueMetalSupplyOpening[] = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'truemetalsupply-dialogs.json'), 'utf8'),
);

/** A non-job dialog (e.g. the site's "Color Chart & SRI Values" popup). */
const COLOR_CHART = {
  text: 'Color Chart & SRI Values\nSelect a color to view its SRI value.',
  html: '<h2>Color Chart &amp; SRI Values</h2><p>Select a color to view its SRI value.</p>',
};

/**
 * Build a `TrueMetalSupplyService` whose `fetchOpenings()` returns the supplied
 * openings (bypassing the real headless browser) and whose `sleep()` is a no-op.
 */
function serviceWithOpenings(openings: TrueMetalSupplyOpening[]): TrueMetalSupplyService {
  const service = new TrueMetalSupplyService();
  jest
    .spyOn(service as unknown as { fetchOpenings: () => Promise<unknown> }, 'fetchOpenings')
    .mockResolvedValue(openings);
  return service;
}

/**
 * Build a fake Playwright `Page` for `collectDialogs`: each entry is the dialog
 * revealed by clicking trigger `i`. `null` entries simulate a trigger that opens
 * no dialog. Exercises the real click/read/filter/dedup loop without a browser.
 */
function fakePage(
  dialogs: Array<{ text: string; html: string | null } | null>,
): unknown {
  let open = -1;
  const triggerLocator = {
    count: async () => dialogs.length,
    nth: (i: number) => ({
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => {
        open = i;
      },
    }),
  };
  const dialogLocator = {
    first: () => ({
      count: async () => (open >= 0 && dialogs[open] ? 1 : 0),
      innerText: async () => dialogs[open]?.text ?? '',
      innerHTML: async () => dialogs[open]?.html ?? null,
    }),
  };
  return {
    locator: (sel: string) =>
      sel === '[role="dialog"]' ? dialogLocator : triggerLocator,
    keyboard: {
      press: async () => {
        open = -1;
      },
    },
  };
}

describe('TrueMetalSupplyService (Spec 5062 — Wix popup careers, headless)', () => {
  it('resolves through TrueMetalSupplyModule via NestJS DI', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TrueMetalSupplyModule],
    }).compile();
    const service = moduleRef.get(TrueMetalSupplyService);
    expect(service).toBeInstanceOf(TrueMetalSupplyService);
    await moduleRef.close();
  });

  it('exports the Site.TRUEMETALSUPPLY = "truemetalsupply" enum value', () => {
    expect(Site.TRUEMETALSUPPLY).toBe('truemetalsupply');
  });

  it('maps all seven live openings with title + description; empty fields stay empty; jobUrl blank', async () => {
    const service = serviceWithOpenings(DIALOGS);
    const result = await service.scrape({} as ScraperInputDto);

    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toHaveLength(7);

    for (const job of result.jobs) {
      expect(job.companyName).toBe(TRUEMETALSUPPLY_COMPANY_NAME);
      expect(job.companyUrl).toBe(TRUEMETALSUPPLY_CAREERS_URL);
      expect(job.site).toBe(Site.TRUEMETALSUPPLY);
      // Decision 3: no per-role URL exists — jobUrl is intentionally blank.
      expect(job.jobUrl).toBe('');
      expect(job.isRemote).toBe(false);
      // Never fabricated.
      expect(job.datePosted).toBeNull();
      expect(job.emails).toEqual([]);
      expect(job.compensation ?? null).toBeNull();
      expect(job.employmentType ?? null).toBeNull();
      expect(job.jobType ?? null).toBeNull();
      expect(job.description).toBeTruthy();
    }

    const titles = result.jobs.map((j) => j.title);
    expect(titles).toEqual([
      'Project Estimator',
      'True Service Rep',
      'Customer Relationship Manager',
      'Delivery Driver',
      'CDL-A Driver',
      'Warehouse Assoc.',
      'Asheville Facility Manager',
    ]);
  });

  it('pins the first row (Project Estimator) id + markdown description', async () => {
    const service = serviceWithOpenings(DIALOGS);
    const result = await service.scrape({} as ScraperInputDto);

    const first = result.jobs[0];
    expect(first.id).toBe('truemetalsupply-project-estimator');
    expect(first.description).toContain('Position Overview');
    expect(first.description).toContain('Key Responsibilities');
    expect(first.description).toContain('Requirements');
  });

  it('derives location only from a facility-city title prefix (Asheville), null otherwise', async () => {
    const service = serviceWithOpenings(DIALOGS);
    const result = await service.scrape({} as ScraperInputDto);

    const byTitle = new Map(result.jobs.map((j) => [j.title, j]));

    // Only the title that prefixes a known facility city carries a location.
    const facility = byTitle.get('Asheville Facility Manager');
    expect(facility?.location?.city).toBe('Asheville');
    expect(facility?.location?.state ?? null).toBeNull();

    // CDL-A mentions "greater Knoxville area" in the BODY, not the title prefix,
    // so it must NOT get a location (free-text extraction is deliberately avoided).
    expect(byTitle.get('CDL-A Driver')?.location ?? null).toBeNull();

    // All other titles have no location prefix → null.
    for (const t of [
      'Project Estimator',
      'True Service Rep',
      'Customer Relationship Manager',
      'Delivery Driver',
      'Warehouse Assoc.',
    ]) {
      expect(byTitle.get(t)?.location ?? null).toBeNull();
    }
  });

  it('collectDialogs keeps job dialogs, drops a non-job dialog, and dedupes by title', async () => {
    const service = serviceWithOpenings([]);
    jest
      .spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);

    const est = DIALOGS[0];
    const del = DIALOGS[3];
    const page = fakePage([
      { text: est.descriptionText, html: est.descriptionHtml }, // job
      COLOR_CHART, // non-job → filtered by JD-marker heuristic
      { text: del.descriptionText, html: del.descriptionHtml }, // job
      { text: est.descriptionText, html: est.descriptionHtml }, // duplicate title → dropped
      null, // trigger opens no dialog → skipped
    ]);

    const openings = await (
      service as unknown as {
        collectDialogs: (p: unknown) => Promise<TrueMetalSupplyOpening[]>;
      }
    ).collectDialogs(page);

    expect(openings.map((o) => o.title)).toEqual([
      'Project Estimator',
      'Delivery Driver',
    ]);
  });

  it('applies searchTerm, offset and resultsWanted', async () => {
    const service = serviceWithOpenings(DIALOGS);

    // searchTerm matches title OR description (same as sibling plugins), so use a
    // term that appears in exactly one role.
    const crm = await service.scrape({
      searchTerm: 'relationship',
    } as ScraperInputDto);
    expect(crm.jobs.map((j) => j.title)).toEqual([
      'Customer Relationship Manager',
    ]);

    const capped = await service.scrape({ resultsWanted: 2 } as ScraperInputDto);
    expect(capped.jobs).toHaveLength(2);

    const offset = await service.scrape({
      resultsWanted: 2,
      offset: 2,
    } as ScraperInputDto);
    expect(offset.jobs[0].title).toBe('Customer Relationship Manager');
  });

  it('returns an empty response when no openings are found', async () => {
    const service = serviceWithOpenings([]);
    const result = await service.scrape({} as ScraperInputDto);
    expect(result.jobs).toEqual([]);
  });

  it('degrades to an empty response when the browser step throws', async () => {
    const service = new TrueMetalSupplyService();
    jest
      .spyOn(service as unknown as { fetchOpenings: () => Promise<unknown> }, 'fetchOpenings')
      .mockRejectedValue(new Error('nav failed'));
    const result = await service.scrape({} as ScraperInputDto);
    expect(result).toBeInstanceOf(JobResponseDto);
    expect(result.jobs).toEqual([]);
  });
});
