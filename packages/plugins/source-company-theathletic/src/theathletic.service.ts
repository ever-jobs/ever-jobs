import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * The Athletic — Subscription-based digital sports journalism publication.
 *
 * The Athletic is a digital sports media company producing
 * subscription-based journalism covering professional and college sports. It
 * is owned by The New York Times.
 *
 * Sector: media. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `theathletic`
 * (`https://jobs.lever.co/theathletic`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'theathletic';
const COMPANY_NAME = 'The Athletic';

@SourcePlugin({
  site: Site.THE_ATHLETIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TheAthleticService implements IScraper {
  private readonly logger = new Logger(TheAthleticService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape The Athletic',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `The Athletic: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.THE_ATHLETIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'theathletic-');
      }
    }

    this.logger.log(`The Athletic: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
