import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';
import { BrowserPool } from '@ever-jobs/common';
import {
  TRUEMETALSUPPLY_CAREERS_URL,
  TRUEMETALSUPPLY_COMPANY_NAME,
  TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR,
  TRUEMETALSUPPLY_DIALOG_SELECTOR,
  TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS,
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

type FakeDialog = {
  text: string;
  html: string | null;
  /** Clicks required before the popup actually opens (default 1). */
  opensAfter?: number;
};

/**
 * Build a fake Playwright `Page` for `collectDialogs`: each entry is the dialog
 * revealed by clicking trigger `i`. `null` entries simulate a trigger that opens
 * no dialog. `opensAfter` models a Wix popup whose first click(s) don't open it
 * (the first-click-not-wired case). Exercises the real click/read/filter/dedup
 * loop — including the open-retry — without a browser.
 */
function fakePage(dialogs: Array<FakeDialog | null>): unknown {
  let open = -1;
  const clicks: Record<number, number> = {};
  const triggerLocator = {
    count: async () => dialogs.length,
    nth: (i: number) => ({
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 50 }),
      getAttribute: async (name: string) =>
        name === 'data-popupid' ? `popup-${i}` : null,
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => {
        clicks[i] = (clicks[i] ?? 0) + 1;
        const spec = dialogs[i];
        if (spec && clicks[i] >= (spec.opensAfter ?? 1)) open = i;
      },
    }),
  };
  const dialogLocator = {
    first: () => ({
      waitFor: async () => undefined,
      isVisible: async () => open >= 0 && !!dialogs[open],
      count: async () => (open >= 0 && dialogs[open] ? 1 : 0),
      innerText: async () => dialogs[open]?.text ?? '',
      innerHTML: async () => dialogs[open]?.html ?? null,
    }),
  };
  return {
    locator: (sel: string) =>
      sel === TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR
        ? triggerLocator
        : dialogLocator,
    keyboard: {
      press: async () => {
        open = -1;
      },
    },
  };
}

describe('TrueMetalSupplyService (Spec 5062 — Wix popup careers, headful)', () => {
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
        collectDialogs: (p: unknown, timeoutMs: number) => Promise<TrueMetalSupplyOpening[]>;
      }
    ).collectDialogs(page, 30000);

    expect(openings.map((o) => o.title)).toEqual([
      'Project Estimator',
      'Delivery Driver',
    ]);
  });

  it('retries a trigger whose first click opens nothing (first-click-not-wired) so the first role is not dropped', async () => {
    const service = serviceWithOpenings([]);
    jest
      .spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);

    const est = DIALOGS[0];
    const del = DIALOGS[3];
    // The first trigger only opens on its SECOND click — mirrors the live Wix
    // board where the first popup click lands before the handler is wired.
    const page = fakePage([
      { text: est.descriptionText, html: est.descriptionHtml, opensAfter: 2 },
      { text: del.descriptionText, html: del.descriptionHtml },
    ]);

    const openings = await (
      service as unknown as {
        collectDialogs: (p: unknown, timeoutMs: number) => Promise<TrueMetalSupplyOpening[]>;
      }
    ).collectDialogs(page, 30000);

    // Without the retry the first role (Project Estimator) would be missing.
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

  it('requests a headful stealth browser when collecting openings', async () => {
    const getPageSpy = jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      ...(fakePage([
        {
          text: 'Project Estimator\nPosition Overview\nKey Responsibilities\nRequirements',
          html: '<div><h2>Project Estimator</h2><p>Position Overview</p><p>Key Responsibilities</p><p>Requirements</p></div>',
        },
      ]) as any),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(null),
      close: jest.fn().mockResolvedValue(undefined),
    } as any);
    const service = new TrueMetalSupplyService();
    jest
      .spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);

    const result = await service.scrape({} as ScraperInputDto);

    expect(getPageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ stealth: true, headful: true }),
    );
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].title).toBe('Project Estimator');

    getPageSpy.mockRestore();
  });

  it('waits for the dialog triggers as ATTACHED with a bounded readiness timeout (Spec 5083)', async () => {
    // The Wix triggers are attached immediately but never Playwright-`visible`,
    // so gating on the default (visible) state burned the whole navigation
    // timeout. Assert we wait for `attached` with the short readiness timeout,
    // not the 30 s navigation budget.
    const waitForSelector = jest.fn().mockResolvedValue(null);
    const getPageSpy = jest.spyOn(BrowserPool, 'getPage').mockResolvedValue({
      ...(fakePage([]) as any),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector,
      close: jest.fn().mockResolvedValue(undefined),
    } as any);
    const service = new TrueMetalSupplyService();
    jest
      .spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);

    await service.scrape({} as ScraperInputDto);

    expect(waitForSelector).toHaveBeenCalledWith(
      TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR,
      expect.objectContaining({
        state: 'attached',
        timeout: TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS * 1000,
      }),
    );

    getPageSpy.mockRestore();
  });
});
