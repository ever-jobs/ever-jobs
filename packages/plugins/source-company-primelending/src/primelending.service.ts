import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * PrimeLending — US residential mortgage lender originating purchase and refinance home loans.
 *
 * PrimeLending is a US residential mortgage lender offering purchase and
 * refinance home loan products, including conventional, FHA, VA, and USDA
 * loans. It is a subsidiary of Hilltop Holdings.
 *
 * Sector: Financial services / mortgage lending. HQ: Dallas, Texas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `PrimeLending`
 * (`https://jobs.smartrecruiters.com/PrimeLending`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PrimeLending';
const COMPANY_NAME = 'PrimeLending';

@SourcePlugin({
  site: Site.PRIMELENDING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PrimeLendingService implements IScraper {
  private readonly logger = new Logger(PrimeLendingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape PrimeLending',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `PrimeLending: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PRIMELENDING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'primelending-');
      }
    }

    this.logger.log(`PrimeLending: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
