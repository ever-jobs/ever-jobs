import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Platinum Healthcare Staffing — Staffing agency placing nurses and healthcare professionals across the United States.
 *
 * Platinum Healthcare Staffing is a US staffing agency that recruits and
 * places registered nurses and other healthcare professionals in travel and
 * contract assignments with hospitals and facilities. It supports a range of
 * clinical specialties.
 *
 * Sector: Healthcare Staffing. HQ: Los Angeles, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `PlatinumHealthcareStaffingInc`
 * (`https://jobs.smartrecruiters.com/PlatinumHealthcareStaffingInc`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PlatinumHealthcareStaffingInc';
const COMPANY_NAME = 'Platinum Healthcare Staffing';

@SourcePlugin({
  site: Site.PLATINUM_HEALTHCARE_STAFFING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PlatinumHealthcareStaffingService implements IScraper {
  private readonly logger = new Logger(PlatinumHealthcareStaffingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Platinum Healthcare Staffing',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Platinum Healthcare Staffing: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PLATINUM_HEALTHCARE_STAFFING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'platinumhealthcarestaffing-');
      }
    }

    this.logger.log(`Platinum Healthcare Staffing: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
