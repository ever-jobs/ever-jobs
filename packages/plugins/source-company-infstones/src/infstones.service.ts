import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * InfStones — Enterprise blockchain infrastructure and node-management platform-as-a-service.
 *
 * InfStones provides blockchain infrastructure as a service, offering a
 * node-management platform that supports tens of thousands of nodes across
 * many blockchain protocols for developers and enterprises.
 *
 * Sector: Blockchain Infrastructure. HQ: Milpitas, California, United States.
 *
 * Source: Lever job board, company slug `infstones`
 * (`https://jobs.lever.co/infstones`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'infstones';
const COMPANY_NAME = 'InfStones';

@SourcePlugin({
  site: Site.INFSTONES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InfStonesService implements IScraper {
  private readonly logger = new Logger(InfStonesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape InfStones',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `InfStones: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INFSTONES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'infstones-');
      }
    }

    this.logger.log(`InfStones: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
