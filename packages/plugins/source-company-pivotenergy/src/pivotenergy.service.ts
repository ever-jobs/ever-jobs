import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pivot Energy — Solar and energy-storage developer, owner, and operator focused on community and commercial solar.
 *
 * Pivot Energy develops, finances, owns, and operates community and
 * commercial solar and storage projects, offering project development, EPC,
 * and asset-management services.
 *
 * Sector: Renewable energy / Solar. HQ: Denver, Colorado, USA.
 *
 * Source: Lever job board, company slug `pivotenergy`
 * (`https://jobs.lever.co/pivotenergy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'pivotenergy';
const COMPANY_NAME = 'Pivot Energy';

@SourcePlugin({
  site: Site.PIVOT_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PivotEnergyService implements IScraper {
  private readonly logger = new Logger(PivotEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Pivot Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pivot Energy: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PIVOT_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'pivotenergy-');
      }
    }

    this.logger.log(`Pivot Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
