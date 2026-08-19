import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * MAT Holdings — Diversified manufacturer of automotive parts, fencing, hardware, and power equipment.
 *
 * MAT Holdings, Inc. is a privately held, multinational manufacturing and
 * distribution company with operations across the automotive aftermarket,
 * fencing, hardware, and power equipment sectors.
 *
 * Sector: Industrial manufacturing / Diversified. HQ: Long Grove, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `MATHoldings`
 * (`https://jobs.smartrecruiters.com/MATHoldings`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'MATHoldings';
const COMPANY_NAME = 'MAT Holdings';

@SourcePlugin({
  site: Site.MAT_HOLDINGS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MATHoldingsService implements IScraper {
  private readonly logger = new Logger(MATHoldingsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape MAT Holdings',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `MAT Holdings: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MAT_HOLDINGS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'matholdings-');
      }
    }

    this.logger.log(`MAT Holdings: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
