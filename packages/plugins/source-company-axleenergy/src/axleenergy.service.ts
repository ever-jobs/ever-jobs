import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Axle Energy — Builds software that connects distributed energy devices to electricity markets.
 *
 * Axle Energy develops software infrastructure that aggregates distributed
 * energy resources such as EV chargers, home batteries, and heat pumps and
 * connects them to electricity and flexibility markets. The platform aims to
 * shift energy use to times when power is cheaper and lower-carbon. The
 * company is based in London.
 *
 * Sector: Grid / distributed energy software. HQ: London, United Kingdom.
 *
 * Source: Ashby job board, company slug `axle-careers`
 * (`https://jobs.ashbyhq.com/axle-careers`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'axle-careers';
const COMPANY_NAME = 'Axle Energy';

@SourcePlugin({
  site: Site.AXLE_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AxleEnergyService implements IScraper {
  private readonly logger = new Logger(AxleEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Axle Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Axle Energy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AXLE_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'axleenergy-');
      }
    }

    this.logger.log(`Axle Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
