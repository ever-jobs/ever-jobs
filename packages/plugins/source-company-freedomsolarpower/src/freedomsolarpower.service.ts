import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Freedom Solar Power — Residential and commercial solar installation company operating primarily in Texas and Florida.
 *
 * Founded in 2007, Freedom Solar Power installs residential and commercial
 * solar systems, with a residential business serving Texas and Florida and a
 * commercial business with nationwide reach.
 *
 * Sector: Renewable energy / Solar. HQ: Austin, Texas, USA.
 *
 * Source: Lever job board, company slug `freedomsolarpower`
 * (`https://jobs.lever.co/freedomsolarpower`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'freedomsolarpower';
const COMPANY_NAME = 'Freedom Solar Power';

@SourcePlugin({
  site: Site.FREEDOM_SOLAR_POWER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FreedomSolarPowerService implements IScraper {
  private readonly logger = new Logger(FreedomSolarPowerService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Freedom Solar Power',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Freedom Solar Power: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FREEDOM_SOLAR_POWER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'freedomsolarpower-');
      }
    }

    this.logger.log(`Freedom Solar Power: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
