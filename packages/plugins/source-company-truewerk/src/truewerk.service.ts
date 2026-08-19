import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Truewerk — Technical workwear brand designing and selling performance work apparel direct to consumers.
 *
 * Truewerk is a Denver-based apparel company that designs technical workwear
 * engineered for tradespeople and industrial workers. It sells performance
 * work apparel through direct and wholesale channels. Products include
 * layering systems, pants, and outerwear built for job-site conditions.
 *
 * Sector: Workwear apparel (retail/e-commerce). HQ: Denver, Colorado, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Truewerk`
 * (`https://jobs.smartrecruiters.com/Truewerk`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Truewerk';
const COMPANY_NAME = 'Truewerk';

@SourcePlugin({
  site: Site.TRUEWERK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TruewerkService implements IScraper {
  private readonly logger = new Logger(TruewerkService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Truewerk',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Truewerk: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRUEWERK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'truewerk-');
      }
    }

    this.logger.log(`Truewerk: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
