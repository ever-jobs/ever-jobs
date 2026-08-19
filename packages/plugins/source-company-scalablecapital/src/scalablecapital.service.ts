import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Scalable Capital — German fintech operating a digital brokerage and wealth-management platform.
 *
 * Scalable Capital is a Munich-based financial technology company offering a
 * digital investment platform that combines a brokerage, ETF savings plans
 * and discretionary portfolio management. It serves retail investors across
 * several European markets and holds a securities-services licence.
 *
 * Sector: Financial technology (digital brokerage & wealth management). HQ: Munich, Bavaria, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `scalablegmbh`
 * (`https://jobs.smartrecruiters.com/scalablegmbh`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'scalablegmbh';
const COMPANY_NAME = 'Scalable Capital';

@SourcePlugin({
  site: Site.SCALABLE_CAPITAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ScalableCapitalService implements IScraper {
  private readonly logger = new Logger(ScalableCapitalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Scalable Capital',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Scalable Capital: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SCALABLE_CAPITAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'scalablecapital-');
      }
    }

    this.logger.log(`Scalable Capital: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
