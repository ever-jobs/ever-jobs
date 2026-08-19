import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fin — A stablecoin-powered payments platform for high-value, global, instant money movement.
 *
 * Fin is a payments platform built for high-value, global, and instant
 * transactions, using stablecoins to move funds between users, into bank
 * accounts, and across crypto rails. It is a Series A-stage company.
 * Investors include Sequoia and Circle.
 *
 * Sector: Fintech - Stablecoin payments. HQ: USA.
 *
 * Source: Ashby job board, company slug `fin`
 * (`https://jobs.ashbyhq.com/fin`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'fin';
const COMPANY_NAME = 'Fin';

@SourcePlugin({
  site: Site.FIN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FinService implements IScraper {
  private readonly logger = new Logger(FinService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Fin',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fin: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'fin-');
      }
    }

    this.logger.log(`Fin: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
