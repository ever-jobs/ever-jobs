import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * GoodLeap — Point-of-sale financing platform for residential solar and sustainable home improvements.
 *
 * GoodLeap provides a point-of-sale financing and technology platform for
 * sustainable home improvements, including residential solar, batteries, and
 * energy-efficiency upgrades, connecting contractors, homeowners, and
 * capital markets.
 *
 * Sector: Lending / Fintech. HQ: Roseville, California, United States.
 *
 * Source: Lever job board, company slug `goodleap`
 * (`https://jobs.lever.co/goodleap`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'goodleap';
const COMPANY_NAME = 'GoodLeap';

@SourcePlugin({
  site: Site.GOODLEAP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GoodLeapService implements IScraper {
  private readonly logger = new Logger(GoodLeapService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape GoodLeap',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `GoodLeap: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GOODLEAP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'goodleap-');
      }
    }

    this.logger.log(`GoodLeap: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
