import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * dLocal — Cross-border payments platform for collecting and disbursing money in emerging markets.
 *
 * dLocal provides a payments platform that enables global merchants to
 * collect payments and make payouts across emerging markets, operating as
 * both a payments processor and merchant of record in 40 countries.
 *
 * Sector: Payments. HQ: Montevideo, Montevideo, Uruguay.
 *
 * Source: Lever job board, company slug `dlocal`
 * (`https://jobs.lever.co/dlocal`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'dlocal';
const COMPANY_NAME = 'dLocal';

@SourcePlugin({
  site: Site.DLOCAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DLocalService implements IScraper {
  private readonly logger = new Logger(DLocalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape dLocal',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `dLocal: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DLOCAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'dlocal-');
      }
    }

    this.logger.log(`dLocal: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
