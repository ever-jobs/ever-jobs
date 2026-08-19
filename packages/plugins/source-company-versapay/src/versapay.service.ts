import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Versapay — B2B accounts-receivable automation and payments platform.
 *
 * Versapay provides accounts-receivable automation and B2B payments software
 * that connects finance teams with their customers to streamline invoicing,
 * collections, and payment acceptance.
 *
 * Sector: Payments / Fintech. HQ: Miami, Florida, United States.
 *
 * Source: Lever job board, company slug `versapay`
 * (`https://jobs.lever.co/versapay`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'versapay';
const COMPANY_NAME = 'Versapay';

@SourcePlugin({
  site: Site.VERSAPAY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VersapayService implements IScraper {
  private readonly logger = new Logger(VersapayService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Versapay',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Versapay: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VERSAPAY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'versapay-');
      }
    }

    this.logger.log(`Versapay: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
