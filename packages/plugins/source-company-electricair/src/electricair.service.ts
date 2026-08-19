import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Electric Air — Installs heat pumps for home heating and cooling and builds its own heat pump platform.
 *
 * Electric Air is a home climate company that installs heat pumps for
 * heating and cooling across the San Francisco Bay Area. It has developed
 * its own heat pump product platform called Redwood. The company focuses on
 * replacing fossil-fuel home heating with electric heat pumps.
 *
 * Sector: Home electrification / heat pumps. HQ: San Francisco Bay Area, California, USA.
 *
 * Source: Ashby job board, company slug `electricair`
 * (`https://jobs.ashbyhq.com/electricair`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'electricair';
const COMPANY_NAME = 'Electric Air';

@SourcePlugin({
  site: Site.ELECTRIC_AIR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ElectricAirService implements IScraper {
  private readonly logger = new Logger(ElectricAirService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Electric Air',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Electric Air: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ELECTRIC_AIR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'electricair-');
      }
    }

    this.logger.log(`Electric Air: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
