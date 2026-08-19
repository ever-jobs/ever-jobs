import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mainspring Energy — Builds fuel-flexible linear generators that convert multiple fuels into local, dispatchable electricity.
 *
 * Mainspring Energy manufactures the Mainspring Linear Generator, a
 * fuel-flexible onsite power-generation technology that can run on fuels
 * such as biogas, hydrogen, ammonia, and natural gas and ramps to meet
 * demand for commercial and industrial customers.
 *
 * Sector: Clean energy / Power generation. HQ: Menlo Park, California, USA.
 *
 * Source: Lever job board, company slug `mainspringenergy`
 * (`https://jobs.lever.co/mainspringenergy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'mainspringenergy';
const COMPANY_NAME = 'Mainspring Energy';

@SourcePlugin({
  site: Site.MAINSPRING_ENERGY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MainspringEnergyService implements IScraper {
  private readonly logger = new Logger(MainspringEnergyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Mainspring Energy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mainspring Energy: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MAINSPRING_ENERGY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'mainspringenergy-');
      }
    }

    this.logger.log(`Mainspring Energy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
