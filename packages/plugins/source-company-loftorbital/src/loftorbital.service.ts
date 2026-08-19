import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Loft Orbital Solutions — Space infrastructure company offering satellite missions as a service.
 *
 * Loft Orbital provides end-to-end satellite missions as a service, letting
 * customers deploy payloads to orbit without building their own spacecraft.
 * It operates satellites and mission-control infrastructure across offices
 * in the US, France, and the UAE.
 *
 * Sector: Space/Aerospace. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `loftorbital`
 * (`https://jobs.lever.co/loftorbital`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'loftorbital';
const COMPANY_NAME = 'Loft Orbital Solutions';

@SourcePlugin({
  site: Site.LOFT_ORBITAL_SOLUTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LoftOrbitalSolutionsService implements IScraper {
  private readonly logger = new Logger(LoftOrbitalSolutionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Loft Orbital Solutions',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Loft Orbital Solutions: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LOFT_ORBITAL_SOLUTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'loftorbital-');
      }
    }

    this.logger.log(`Loft Orbital Solutions: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
