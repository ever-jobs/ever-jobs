import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Overview Energy — Develops satellites that beam solar energy to terrestrial solar farms so they can generate power around the clock.
 *
 * Overview Energy is developing space-based solar power technology that
 * collects sunlight in orbit and transmits it as near-infrared laser light
 * to existing solar installations on Earth. The goal is to let solar farms
 * generate power at night and become a 24/7 energy resource. The company has
 * demonstrated airborne power-beaming and targets orbital demonstrations
 * later this decade.
 *
 * Sector: Space-based solar power. HQ: USA.
 *
 * Source: Ashby job board, company slug `overviewenergy`
 * (`https://jobs.ashbyhq.com/overviewenergy`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'overviewenergy';
const COMPANY_NAME = 'Overview Energy';

@SourcePlugin({
  site: Site.OVERVIEW_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OverviewEnergyService implements IScraper {
  private readonly logger = new Logger(OverviewEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Overview Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Overview Energy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OVERVIEW_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'overviewenergy-');
      }
    }

    this.logger.log(`Overview Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
