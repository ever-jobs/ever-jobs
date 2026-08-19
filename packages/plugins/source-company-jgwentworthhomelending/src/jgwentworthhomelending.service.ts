import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * JG Wentworth Home Lending — US mortgage lender originating conventional, VA, and FHA home loans.
 *
 * JG Wentworth Home Lending is a US mortgage lending business that
 * originates conventional, VA, and FHA loans. It is part of The J.G.
 * Wentworth Company and is licensed to operate across many US states.
 *
 * Sector: Financial services / mortgage lending. HQ: Woodbridge, Virginia, USA.
 *
 * Source: SmartRecruiters job board, company identifier `JGWentworthHomeLendingLLC`
 * (`https://jobs.smartrecruiters.com/JGWentworthHomeLendingLLC`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'JGWentworthHomeLendingLLC';
const COMPANY_NAME = 'JG Wentworth Home Lending';

@SourcePlugin({
  site: Site.JG_WENTWORTH_HOME_LENDING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class JGWentworthHomeLendingService implements IScraper {
  private readonly logger = new Logger(JGWentworthHomeLendingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape JG Wentworth Home Lending',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `JG Wentworth Home Lending: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.JG_WENTWORTH_HOME_LENDING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'jgwentworthhomelending-');
      }
    }

    this.logger.log(`JG Wentworth Home Lending: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
