import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Zoox — Autonomous robotaxi company building purpose-built driverless vehicles.
 *
 * Zoox develops a purpose-built autonomous robotaxi and the full-stack
 * self-driving system that operates it. It is a subsidiary of Amazon and
 * runs test and deployment operations in multiple US cities.
 *
 * Sector: Autonomous Vehicles. HQ: Foster City, California, United States.
 *
 * Source: Lever job board, company slug `zoox`
 * (`https://jobs.lever.co/zoox`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'zoox';
const COMPANY_NAME = 'Zoox';

@SourcePlugin({
  site: Site.ZOOX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ZooxService implements IScraper {
  private readonly logger = new Logger(ZooxService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Zoox',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Zoox: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ZOOX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'zoox-');
      }
    }

    this.logger.log(`Zoox: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
