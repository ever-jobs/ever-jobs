import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Nium — Real-time cross-border payments infrastructure for banks and businesses.
 *
 * Nium provides real-time cross-border payments infrastructure, enabling
 * banks and businesses to move money globally with capabilities including
 * account transfers, wallet disbursements, card issuance, and local
 * collections.
 *
 * Sector: Payments. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `nium`
 * (`https://jobs.lever.co/nium`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'nium';
const COMPANY_NAME = 'Nium';

@SourcePlugin({
  site: Site.NIUM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NiumService implements IScraper {
  private readonly logger = new Logger(NiumService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Nium',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Nium: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NIUM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'nium-');
      }
    }

    this.logger.log(`Nium: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
