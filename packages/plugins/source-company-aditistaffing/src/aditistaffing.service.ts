import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Aditi Staffing — IT staffing firm providing contract and direct-hire technology talent.
 *
 * Aditi Staffing is an IT staffing company offering contract,
 * contract-to-hire and direct-hire placement of technology professionals to
 * enterprise clients. It is a certified minority business enterprise.
 *
 * Sector: IT staffing. HQ: Bellevue, Washington, United States.
 *
 * Source: SmartRecruiters job board, company identifier `AditiStaffing1`
 * (`https://jobs.smartrecruiters.com/AditiStaffing1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AditiStaffing1';
const COMPANY_NAME = 'Aditi Staffing';

@SourcePlugin({
  site: Site.ADITI_STAFFING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AditiStaffingService implements IScraper {
  private readonly logger = new Logger(AditiStaffingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Aditi Staffing',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Aditi Staffing: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ADITI_STAFFING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'aditistaffing-');
      }
    }

    this.logger.log(`Aditi Staffing: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
