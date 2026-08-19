import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Voltus — Virtual power plant operator that aggregates distributed energy resources and pays users to shift electricity demand.
 *
 * Voltus operates a distributed energy resource platform that connects
 * commercial and industrial energy users to wholesale markets, paying them
 * to reduce or shift electricity use in response to grid stress, high
 * prices, and high emissions.
 *
 * Sector: Energy / Demand response. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `voltus`
 * (`https://jobs.lever.co/voltus`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'voltus';
const COMPANY_NAME = 'Voltus';

@SourcePlugin({
  site: Site.VOLTUS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VoltusService implements IScraper {
  private readonly logger = new Logger(VoltusService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Voltus',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Voltus: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VOLTUS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'voltus-');
      }
    }

    this.logger.log(`Voltus: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
