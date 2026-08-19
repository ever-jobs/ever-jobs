import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Blue Energy — Develops nuclear power projects using shipyard-style manufacturing to deploy new capacity faster.
 *
 * Blue Energy is a company working to deploy new nuclear generation capacity
 * at scale, aiming to speed up the path to building nuclear megawatts. Its
 * approach centers on manufacturing and siting methods intended to reduce
 * the cost and time of nuclear deployment. The company positions its work
 * around energy security and decarbonization.
 *
 * Sector: Nuclear energy. HQ: USA.
 *
 * Source: Ashby job board, company slug `blue-energy`
 * (`https://jobs.ashbyhq.com/blue-energy`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'blue-energy';
const COMPANY_NAME = 'Blue Energy';

@SourcePlugin({
  site: Site.BLUE_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BlueEnergyService implements IScraper {
  private readonly logger = new Logger(BlueEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Blue Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Blue Energy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BLUE_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'blueenergy-');
      }
    }

    this.logger.log(`Blue Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
