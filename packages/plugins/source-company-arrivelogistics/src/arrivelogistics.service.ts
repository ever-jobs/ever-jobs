import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Arrive Logistics — Freight brokerage and transportation logistics provider.
 *
 * Arrive Logistics is a freight brokerage company providing truckload,
 * less-than-truckload and other transportation services connecting shippers
 * and carriers across North America.
 *
 * Sector: logistics. HQ: Austin, Texas, United States.
 *
 * Source: Lever job board, company slug `arrivelogistics`
 * (`https://jobs.lever.co/arrivelogistics`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'arrivelogistics';
const COMPANY_NAME = 'Arrive Logistics';

@SourcePlugin({
  site: Site.ARRIVE_LOGISTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ArriveLogisticsService implements IScraper {
  private readonly logger = new Logger(ArriveLogisticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Arrive Logistics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Arrive Logistics: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARRIVE_LOGISTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'arrivelogistics-');
      }
    }

    this.logger.log(`Arrive Logistics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
