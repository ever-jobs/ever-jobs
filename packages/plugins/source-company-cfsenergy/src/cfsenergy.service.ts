import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Commonwealth Fusion Systems — Private fusion-energy company developing a compact tokamak reactor using high-temperature superconducting magnets.
 *
 * Commonwealth Fusion Systems is developing commercial fusion power plants
 * based on high-temperature superconducting magnet technology, building the
 * SPARC and ARC machines to demonstrate net-energy fusion.
 *
 * Sector: Clean energy / Fusion. HQ: Devens, Massachusetts, USA.
 *
 * Source: Lever job board, company slug `cfsenergy`
 * (`https://jobs.lever.co/cfsenergy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cfsenergy';
const COMPANY_NAME = 'Commonwealth Fusion Systems';

@SourcePlugin({
  site: Site.COMMONWEALTH_FUSION_SYSTEMS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CommonwealthFusionSystemsService implements IScraper {
  private readonly logger = new Logger(CommonwealthFusionSystemsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Commonwealth Fusion Systems',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Commonwealth Fusion Systems: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COMMONWEALTH_FUSION_SYSTEMS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'cfsenergy-');
      }
    }

    this.logger.log(`Commonwealth Fusion Systems: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
