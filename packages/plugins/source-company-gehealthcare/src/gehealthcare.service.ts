import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * GE HealthCare — Medical technology company providing imaging, ultrasound, and patient care solutions.
 *
 * GE HealthCare is a medical technology company that develops imaging
 * systems, ultrasound, patient monitoring, and related diagnostic and care
 * solutions for hospitals and healthcare providers. It became an independent
 * public company after separating from General Electric in 2023.
 *
 * Sector: Medical Devices / Medical Technology. HQ: Chicago, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `GEHealthcare2`
 * (`https://jobs.smartrecruiters.com/GEHealthcare2`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'GEHealthcare2';
const COMPANY_NAME = 'GE HealthCare';

@SourcePlugin({
  site: Site.GE_HEALTHCARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GEHealthCareService implements IScraper {
  private readonly logger = new Logger(GEHealthCareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape GE HealthCare',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `GE HealthCare: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GE_HEALTHCARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'gehealthcare-');
      }
    }

    this.logger.log(`GE HealthCare: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
