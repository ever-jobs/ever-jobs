import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HappyCo — Real-time property data platform for the multifamily real-estate sector.
 *
 * HappyCo builds mobile and cloud software that captures real-time property
 * data and unifies operational data into an entity model and property graph
 * for multifamily property management analytics.
 *
 * Sector: Property data platform. HQ: Adelaide, South Australia, Australia.
 *
 * Source: Lever job board, company slug `happyco`
 * (`https://jobs.lever.co/happyco`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'happyco';
const COMPANY_NAME = 'HappyCo';

@SourcePlugin({
  site: Site.HAPPYCO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HappyCoService implements IScraper {
  private readonly logger = new Logger(HappyCoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape HappyCo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `HappyCo: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HAPPYCO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'happyco-');
      }
    }

    this.logger.log(`HappyCo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
