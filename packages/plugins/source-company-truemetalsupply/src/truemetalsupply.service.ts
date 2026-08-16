import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SourcePlugin } from '@ever-jobs/plugin';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
  classifyScrapeError,
} from '@ever-jobs/models';
import { BrowserPool, markdownConverter, parseLocationList } from '@ever-jobs/common';
import type { Page } from 'playwright';
import {
  TRUEMETALSUPPLY_CAREERS_URL,
  TRUEMETALSUPPLY_COMPANY_NAME,
  TRUEMETALSUPPLY_DEFAULT_RESULTS,
  TRUEMETALSUPPLY_DEFAULT_TIMEOUT_SECONDS,
  TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS,
  TRUEMETALSUPPLY_DIALOG_OPEN_ATTEMPTS,
  TRUEMETALSUPPLY_DIALOG_SELECTOR,
  TRUEMETALSUPPLY_DIALOG_SETTLE_MS,
  TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS,
  TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR,
  TRUEMETALSUPPLY_FACILITY_CITIES,
  TRUEMETALSUPPLY_JD_MARKER_MIN,
  TRUEMETALSUPPLY_JD_MARKERS,
} from './truemetalsupply.constants';
import { TrueMetalSupplyOpening } from './truemetalsupply.types';

/**
 * True Metal Supply — custom Wix careers page, no ATS.
 *
 * The openings live in Wix popup/lightbox dialogs that are only rendered after a
 * client-side click, so the page is driven with the shared headless `BrowserPool`
 * (stealth) rather than plain HTTP: open `/careers`, click each dialog trigger,
 * and read the rendered popup. Only title + full description are stated by the
 * employer; everything else is left empty (never fabricated). A per-role location
 * is emitted only when the title itself prefixes a known facility city.
 */
@SourcePlugin({
  site: Site.TRUEMETALSUPPLY,
  name: 'True Metal Supply',
  category: 'company',
})
@Injectable()
export class TrueMetalSupplyService implements IScraper, OnModuleDestroy {
  private readonly logger = new Logger(TrueMetalSupplyService.name);

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    try {
      const openings = await this.fetchOpenings(input);
      if (openings.length === 0) {
        this.logger.warn(
          'True Metal Supply: no openings found on the careers page',
        );
        return new JobResponseDto([], { reason: 'empty' });
      }

      const jobs = openings.map((opening) => this.toJobPost(opening));
      const out = this.applyInput(jobs, input);
      this.logger.log(`True Metal Supply: scraped ${out.length} jobs`);
      return new JobResponseDto(out);
    } catch (error: unknown) {
      const diagnostics = classifyScrapeError(error);
      this.logger.error(
        `True Metal Supply scrape failed [${diagnostics.reason}]: ${diagnostics.detail ?? this.errorLabel(error)}`,
      );
      return new JobResponseDto([], diagnostics);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await BrowserPool.close().catch(() => undefined);
  }

  /**
   * Drive a stealth headful browser: open `/careers`, click every visible
   * dialog trigger, and capture the rendered popup for each real opening.
   * Isolated so tests can substitute captured dialogs without a browser. The
   * page is always closed in `finally`.
   */
  protected async fetchOpenings(
    input: ScraperInputDto,
  ): Promise<TrueMetalSupplyOpening[]> {
    const proxy = input.proxies?.[0];
    const timeoutMs =
      (input.requestTimeout ?? TRUEMETALSUPPLY_DEFAULT_TIMEOUT_SECONDS) * 1000;
    const readyMs = TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS * 1000;

    const page = await BrowserPool.getPage({ proxy, stealth: true, headful: true });
    try {
      await page.goto(TRUEMETALSUPPLY_CAREERS_URL, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      // The Wix triggers are ATTACHED almost immediately but never become
      // Playwright-`visible`, so the default (visible) wait burned the whole
      // navigation timeout. Gate on `attached` with a bounded readiness timeout;
      // `collectDialogs` enumerates them via `locator.count()` regardless.
      await page
        .waitForSelector(TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR, {
          state: 'attached',
          timeout: readyMs,
        })
        .catch(() => undefined);

      return await this.collectDialogs(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Click each visible dialog trigger in turn, read the opened popup by its
   * Wix popup id, and keep the ones whose body looks like a job description.
   * Deduped by title.
   */
  private async collectDialogs(
    page: Page,
  ): Promise<TrueMetalSupplyOpening[]> {
    const triggers = page.locator(TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR);
    const count = await triggers.count();

    const openings: TrueMetalSupplyOpening[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < count; i++) {
      const trigger = triggers.nth(i);
      try {
        const box = await trigger.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;

        await trigger.scrollIntoViewIfNeeded({ timeout: 5000 });

        const popupId = await trigger.getAttribute('data-popupid');
        const dialog = await this.openTriggerDialog(page, trigger, popupId);
        if ((await dialog.count()) === 0) continue;

        const descriptionText = await dialog.innerText().catch(() => '');
        const descriptionHtml = await dialog.innerHTML().catch(() => null);

        await page.keyboard.press('Escape').catch(() => undefined);
        await this.sleep(TRUEMETALSUPPLY_DIALOG_SETTLE_MS);

        if (!this.isJobDialog(descriptionText)) continue;

        const title = this.titleFromText(descriptionText);
        if (!title) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        openings.push({ title, descriptionHtml, descriptionText });
      } catch (error: unknown) {
        this.logger.debug(
          `True Metal Supply: dialog ${i} skipped (${this.errorLabel(error)})`,
        );
      }
    }

    return openings;
  }

  /**
   * Click a trigger and return its popup locator, retrying the click up to
   * `TRUEMETALSUPPLY_DIALOG_OPEN_ATTEMPTS` times. The first Wix popup click of a
   * page can land before Thunderbolt wires the handler and open nothing; a
   * re-click (after Escape + settle) then succeeds. Each attempt's visibility
   * wait stays bounded so a genuinely non-opening trigger can't serialize into
   * the navigation timeout.
   */
  private async openTriggerDialog(
    page: Page,
    trigger: ReturnType<Page['locator']>,
    popupId: string | null,
  ): Promise<ReturnType<Page['locator']>> {
    const dialog = popupId
      ? page.locator(`[id="${popupId}"]`).first()
      : page.locator(TRUEMETALSUPPLY_DIALOG_SELECTOR).first();

    for (let attempt = 0; attempt < TRUEMETALSUPPLY_DIALOG_OPEN_ATTEMPTS; attempt++) {
      await trigger.click({ timeout: 8000 }).catch(() => undefined);
      await this.sleep(TRUEMETALSUPPLY_DIALOG_SETTLE_MS);

      await dialog
        .waitFor({
          state: 'visible',
          timeout: TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS,
        })
        .catch(() => undefined);
      if (await dialog.isVisible().catch(() => false)) break;

      // Not open — reset and try once more (first-click-not-wired case).
      await page.keyboard.press('Escape').catch(() => undefined);
      await this.sleep(TRUEMETALSUPPLY_DIALOG_SETTLE_MS);
    }

    return dialog;
  }

  private toJobPost(opening: TrueMetalSupplyOpening): JobPostDto {
    const title = this.normalize(opening.title);
    const description = opening.descriptionHtml
      ? markdownConverter(opening.descriptionHtml)
      : null;
    const location = this.titlePrefixLocation(title);

    return new JobPostDto({
      id: `truemetalsupply-${this.slugify(title)}`,
      site: Site.TRUEMETALSUPPLY,
      title,
      companyName: TRUEMETALSUPPLY_COMPANY_NAME,
      companyUrl: TRUEMETALSUPPLY_CAREERS_URL,
      // The employer publishes no per-role job URL (openings are Wix popups);
      // jobUrl is intentionally left blank.
      jobUrl: '',
      location,
      description,
      isRemote: false,
      // Not stated by the employer — never fabricated.
      datePosted: null,
      emails: [],
    });
  }

  /**
   * A dialog is a real opening when its text carries at least
   * `TRUEMETALSUPPLY_JD_MARKER_MIN` job-description section markers. This keeps
   * non-job dialogs (e.g. a color-chart popup) out without hard-coding titles.
   */
  private isJobDialog(text: string): boolean {
    const norm = (text ?? '').replace(/\u00a0/g, ' ').toLowerCase();
    let hits = 0;
    for (const marker of TRUEMETALSUPPLY_JD_MARKERS) {
      if (norm.includes(marker)) hits++;
      if (hits >= TRUEMETALSUPPLY_JD_MARKER_MIN) return true;
    }
    return false;
  }

  /** The rendered role title is the dialog's first non-empty line. */
  private titleFromText(text: string): string {
    for (const line of (text ?? '').split('\n')) {
      const trimmed = this.normalize(line);
      if (trimmed) return trimmed;
    }
    return '';
  }

  /**
   * Emit a location only when the title's leading token is one of the company's
   * known facility cities (e.g. "Asheville Facility Manager" → Asheville). Uses
   * the shared location parser; the HQ is never synthesized, and a non-location
   * leading word yields null.
   */
  private titlePrefixLocation(title: string): LocationDto | null {
    const firstWord = this.normalize(title).split(/\s+/)[0] ?? '';
    if (!firstWord) return null;
    const city = TRUEMETALSUPPLY_FACILITY_CITIES.find(
      (c) => c.toLowerCase() === firstWord.toLowerCase(),
    );
    if (!city) return null;
    return parseLocationList([city]).location;
  }

  private applyInput(jobs: JobPostDto[], input: ScraperInputDto): JobPostDto[] {
    let filtered = jobs;

    const searchTerm = this.normalize(input.searchTerm).toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter((job) =>
        [job.title, job.description].some((value) =>
          this.normalize(value).toLowerCase().includes(searchTerm),
        ),
      );
    }

    const locationTerm = this.normalize(input.location).toLowerCase();
    if (locationTerm) {
      filtered = filtered.filter((job) =>
        this.normalize(job.location?.displayLocation())
          .toLowerCase()
          .includes(locationTerm),
      );
    }

    if (input.isRemote === true) {
      filtered = filtered.filter((job) => job.isRemote === true);
    }

    if (input.jobType) {
      filtered = filtered.filter((job) =>
        job.jobType?.includes(input.jobType as JobType),
      );
    }

    const offset = this.nonNegativeInt(input.offset, 0);
    const requested = this.nonNegativeInt(
      input.resultsWanted,
      TRUEMETALSUPPLY_DEFAULT_RESULTS,
    );
    return filtered.slice(offset, offset + requested);
  }

  private slugify(text: string): string {
    return (
      this.normalize(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'role'
    );
  }

  private normalize(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errorLabel(error: unknown): string {
    if (!error || typeof error !== 'object') return 'unknown error';
    const status = (error as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' && name ? name : 'request error';
  }
}
