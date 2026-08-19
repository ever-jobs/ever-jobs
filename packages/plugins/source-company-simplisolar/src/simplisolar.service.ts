import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Simplisolar — Residential solar sales and installation company operating in the western United States.
 *
 * Simplisolar is a residential solar company that sells and installs rooftop
 * solar systems, primarily in the western United States. Its roles center on
 * solar energy consulting and residential sales.
 *
 * Sector: Residential Solar. HQ: Provo, Utah, United States.
 *
 * Source: SmartRecruiters job board, company identifier `Simplisolar`
 * (`https://jobs.smartrecruiters.com/Simplisolar`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Simplisolar';
const COMPANY_NAME = 'Simplisolar';

@SourcePlugin({
  site: Site.SIMPLISOLAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SimplisolarService implements IScraper {
  private readonly logger = new Logger(SimplisolarService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Simplisolar',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Simplisolar: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SIMPLISOLAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'simplisolar-');
      }
    }

    this.logger.log(`Simplisolar: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
