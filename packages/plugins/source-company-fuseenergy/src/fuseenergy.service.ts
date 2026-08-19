import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fuse Energy — Develops pulsed-power fusion technology and related high-energy systems.
 *
 * Fuse is a company working on fusion energy using pulsed-power technology
 * and high-energy laser and electrical systems. It employs engineers and
 * computational physicists across sites including San Leandro, California
 * and Montreal. The company's work is aimed at advancing the path toward
 * fusion energy.
 *
 * Sector: Fusion energy. HQ: San Leandro, California, USA.
 *
 * Source: Ashby job board, company slug `fuse`
 * (`https://jobs.ashbyhq.com/fuse`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'fuse';
const COMPANY_NAME = 'Fuse Energy';

@SourcePlugin({
  site: Site.FUSE_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FuseEnergyService implements IScraper {
  private readonly logger = new Logger(FuseEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Fuse Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fuse Energy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FUSE_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'fuseenergy-');
      }
    }

    this.logger.log(`Fuse Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
