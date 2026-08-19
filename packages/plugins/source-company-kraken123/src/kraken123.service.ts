import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Kraken — Energy-tech platform providing utilities with customer management, billing, and flexibility-optimization software for the energy transition.
 *
 * Kraken, the technology arm associated with Octopus Energy, licenses an
 * operating system for energy that handles customer information, billing,
 * meter data, CRM, and renewable-generation optimization for utilities
 * worldwide.
 *
 * Sector: Energy software / Utilities. HQ: London, England, United Kingdom.
 *
 * Source: Lever job board, company slug `kraken123`
 * (`https://jobs.lever.co/kraken123`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'kraken123';
const COMPANY_NAME = 'Kraken';

@SourcePlugin({
  site: Site.KRAKEN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KrakenService implements IScraper {
  private readonly logger = new Logger(KrakenService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Kraken',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Kraken: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KRAKEN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'kraken123-');
      }
    }

    this.logger.log(`Kraken: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
