import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sailor Health — Provides in-home and virtual clinical care programs for older adults.
 *
 * Sailor Health delivers clinical care services aimed at older adults and
 * Medicare populations. Its programs combine virtual and in-person clinical
 * engagement. The company hires clinical and operational staff across the
 * United States.
 *
 * Sector: Healthtech (senior / value-based care). HQ: United States.
 *
 * Source: Ashby job board, company slug `sailorhealth`
 * (`https://jobs.ashbyhq.com/sailorhealth`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sailorhealth';
const COMPANY_NAME = 'Sailor Health';

@SourcePlugin({
  site: Site.SAILOR_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SailorHealthService implements IScraper {
  private readonly logger = new Logger(SailorHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Sailor Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sailor Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SAILOR_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sailorhealth-');
      }
    }

    this.logger.log(`Sailor Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
