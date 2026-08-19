import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Shaw\'s — New England supermarket chain and part of the Albertsons family of grocery stores.
 *
 * Shaw's is a supermarket chain operating across New England and part of the
 * Albertsons Companies group. It runs full-service grocery stores offering
 * food, pharmacy, and household goods. The chain has roots dating to the
 * 19th century and employs thousands of associates.
 *
 * Sector: Grocery retail (supermarkets). HQ: West Bridgewater, Massachusetts, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Shaws`
 * (`https://jobs.smartrecruiters.com/Shaws`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Shaws';
const COMPANY_NAME = 'Shaw\'s';

@SourcePlugin({
  site: Site.SHAW_S,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ShawSService implements IScraper {
  private readonly logger = new Logger(ShawSService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Shaw\'s',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Shaw\'s: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SHAW_S;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'shaws-');
      }
    }

    this.logger.log(`Shaw\'s: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
