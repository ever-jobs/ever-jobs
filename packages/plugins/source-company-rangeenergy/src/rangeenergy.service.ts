import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Range Energy — Builds electrified powered trailers (eTrailers) that add propulsion and batteries to conventional semi-trucks.
 *
 * Range Energy develops a powered eTrailer system that adds an electric
 * drivetrain and battery pack to standard tractor-trailers, aiming to
 * improve fuel efficiency and reduce emissions for freight without replacing
 * the truck.
 *
 * Sector: Electric mobility / Transportation. HQ: Mountain View, California, USA.
 *
 * Source: Lever job board, company slug `rangeenergy`
 * (`https://jobs.lever.co/rangeenergy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'rangeenergy';
const COMPANY_NAME = 'Range Energy';

@SourcePlugin({
  site: Site.RANGE_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RangeEnergyService implements IScraper {
  private readonly logger = new Logger(RangeEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Range Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Range Energy: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RANGE_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'rangeenergy-');
      }
    }

    this.logger.log(`Range Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
