import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Array Labs — Radar satellite constellation for 3D imaging of Earth.
 *
 * Array Labs is developing a coordinated fleet of radar satellites designed
 * to produce high-resolution 3D maps of the Earth's surface, building the
 * satellites, radar payloads, and data products end-to-end.
 *
 * Sector: Space/Aerospace. HQ: Redwood City, California, United States.
 *
 * Source: Lever job board, company slug `arraylabs.io`
 * (`https://jobs.lever.co/arraylabs.io`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'arraylabs.io';
const COMPANY_NAME = 'Array Labs';

@SourcePlugin({
  site: Site.ARRAY_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ArrayLabsService implements IScraper {
  private readonly logger = new Logger(ArrayLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Array Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Array Labs: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARRAY_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'arraylabsio-');
      }
    }

    this.logger.log(`Array Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
