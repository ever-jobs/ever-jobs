import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * PenFinancial Credit Union — Ontario-based credit union offering personal and business banking services.
 *
 * PenFinancial Credit Union is a member-owned financial cooperative based in
 * the Niagara region of Ontario, Canada. It provides personal and business
 * banking, lending, and investment services to its members.
 *
 * Sector: Banking / credit union. HQ: Niagara region, Ontario, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `PenFinancialCreditUnion`
 * (`https://jobs.smartrecruiters.com/PenFinancialCreditUnion`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PenFinancialCreditUnion';
const COMPANY_NAME = 'PenFinancial Credit Union';

@SourcePlugin({
  site: Site.PENFINANCIAL_CREDIT_UNION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PenFinancialCreditUnionService implements IScraper {
  private readonly logger = new Logger(PenFinancialCreditUnionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape PenFinancial Credit Union',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `PenFinancial Credit Union: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PENFINANCIAL_CREDIT_UNION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'penfinancialcreditunion-');
      }
    }

    this.logger.log(`PenFinancial Credit Union: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
