import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hevo Data — No-code data pipeline platform for automated data integration.
 *
 * Hevo Data provides a no-code data pipeline platform that moves and
 * transforms data from many sources into cloud data warehouses in near real
 * time. Its teams are based primarily in India.
 *
 * Sector: B2B SaaS / Data Integration. HQ: Bengaluru, Karnataka, India.
 *
 * Source: Lever job board, company slug `hevodata`
 * (`https://jobs.lever.co/hevodata`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hevodata';
const COMPANY_NAME = 'Hevo Data';

@SourcePlugin({
  site: Site.HEVO_DATA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HevoDataService implements IScraper {
  private readonly logger = new Logger(HevoDataService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Hevo Data',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hevo Data: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HEVO_DATA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'hevodata-');
      }
    }

    this.logger.log(`Hevo Data: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
