import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Revefi — Agentic-AI platform for data reliability, quality, operations, and cloud-cost optimization.
 *
 * Revefi provides an agentic-AI platform that helps enterprises manage data
 * reliability, quality, operations, and cloud spend. It was founded in 2021
 * by co-founders of ThoughtSpot and is Series A funded.
 *
 * Sector: Data observability / AI platform. HQ: United States (with an office in Bangalore, India).
 *
 * Source: Lever job board, company slug `revefi`
 * (`https://jobs.lever.co/revefi`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'revefi';
const COMPANY_NAME = 'Revefi';

@SourcePlugin({
  site: Site.REVEFI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RevefiService implements IScraper {
  private readonly logger = new Logger(RevefiService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Revefi',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Revefi: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REVEFI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'revefi-');
      }
    }

    this.logger.log(`Revefi: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
