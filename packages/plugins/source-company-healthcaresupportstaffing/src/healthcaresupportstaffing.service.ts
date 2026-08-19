import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Healthcare Support Staffing — Staffing firm placing clinical and non-clinical professionals across the US healthcare industry.
 *
 * Healthcare Support Staffing is a US staffing company that recruits and
 * places healthcare professionals, including nurses, allied health, and
 * administrative staff, with hospitals, health plans, and other healthcare
 * organizations. It supports both permanent and contract placements.
 *
 * Sector: Healthcare Staffing. HQ: Orlando, Florida, USA.
 *
 * Source: SmartRecruiters job board, company identifier `HealthcareSupportStaffing1`
 * (`https://jobs.smartrecruiters.com/HealthcareSupportStaffing1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'HealthcareSupportStaffing1';
const COMPANY_NAME = 'Healthcare Support Staffing';

@SourcePlugin({
  site: Site.HEALTHCARE_SUPPORT_STAFFING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HealthcareSupportStaffingService implements IScraper {
  private readonly logger = new Logger(HealthcareSupportStaffingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Healthcare Support Staffing',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Healthcare Support Staffing: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HEALTHCARE_SUPPORT_STAFFING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'healthcaresupportstaffing-');
      }
    }

    this.logger.log(`Healthcare Support Staffing: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
