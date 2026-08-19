import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hims & Hers (You Health) — Telehealth provider network serving Hims & Hers direct-to-consumer care.
 *
 * This Ashby board hosts licensed medical provider roles for the Hims & Hers
 * telehealth platform, which offers direct-to-consumer care across areas
 * including weight management, mental health, sexual health, and
 * dermatology. Providers deliver care via telehealth. Hims & Hers is a
 * publicly traded company.
 *
 * Sector: Healthtech (telehealth). HQ: San Francisco, CA, USA.
 *
 * Source: Ashby job board, company slug `you-health`
 * (`https://jobs.ashbyhq.com/you-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'you-health';
const COMPANY_NAME = 'Hims & Hers (You Health)';

@SourcePlugin({
  site: Site.HIMS_HERS_YOU_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HimsHersYouHealthService implements IScraper {
  private readonly logger = new Logger(HimsHersYouHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Hims & Hers (You Health)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hims & Hers (You Health): delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIMS_HERS_YOU_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'himshersyouhealth-');
      }
    }

    this.logger.log(`Hims & Hers (You Health): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
