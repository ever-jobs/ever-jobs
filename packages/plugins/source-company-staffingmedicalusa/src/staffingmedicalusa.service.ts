import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Staffing Medical USA — Medical staffing company recruiting and placing healthcare professionals in the US.
 *
 * Staffing Medical USA is a US healthcare staffing company that recruits and
 * places nurses and other medical professionals into facilities and
 * assignments. It supports clinical hiring for healthcare employers.
 *
 * Sector: Healthcare Staffing. HQ: Batesville, Arkansas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `StaffingMedicalUSA`
 * (`https://jobs.smartrecruiters.com/StaffingMedicalUSA`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'StaffingMedicalUSA';
const COMPANY_NAME = 'Staffing Medical USA';

@SourcePlugin({
  site: Site.STAFFING_MEDICAL_USA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StaffingMedicalUSAService implements IScraper {
  private readonly logger = new Logger(StaffingMedicalUSAService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Staffing Medical USA',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Staffing Medical USA: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STAFFING_MEDICAL_USA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'staffingmedicalusa-');
      }
    }

    this.logger.log(`Staffing Medical USA: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
