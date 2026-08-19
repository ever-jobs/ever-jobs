import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Solar Landscape — Commercial and community rooftop solar developer building distributed generation and battery storage across the US.
 *
 * Solar Landscape develops, builds, owns, and operates commercial rooftop
 * and community solar projects along with battery energy storage, with
 * offices in Chicago, Baltimore, and New York City and operations across
 * more than a dozen states.
 *
 * Sector: Renewable energy / Solar. HQ: Asbury Park, New Jersey, USA.
 *
 * Source: Lever job board, company slug `solarlandscape`
 * (`https://jobs.lever.co/solarlandscape`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'solarlandscape';
const COMPANY_NAME = 'Solar Landscape';

@SourcePlugin({
  site: Site.SOLAR_LANDSCAPE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SolarLandscapeService implements IScraper {
  private readonly logger = new Logger(SolarLandscapeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Solar Landscape',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Solar Landscape: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SOLAR_LANDSCAPE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'solarlandscape-');
      }
    }

    this.logger.log(`Solar Landscape: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
