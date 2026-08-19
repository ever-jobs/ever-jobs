import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Revinate — Hospitality customer data platform that unifies and analyzes hotel guest data.
 *
 * Revinate provides an AI-powered customer data platform for the hospitality
 * industry, unifying and synthesizing guest data across hotels to drive
 * direct bookings and marketing.
 *
 * Sector: Customer data platform (CDP). HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `revinate`
 * (`https://jobs.lever.co/revinate`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'revinate';
const COMPANY_NAME = 'Revinate';

@SourcePlugin({
  site: Site.REVINATE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RevinateService implements IScraper {
  private readonly logger = new Logger(RevinateService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Revinate',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Revinate: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REVINATE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'revinate-');
      }
    }

    this.logger.log(`Revinate: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
