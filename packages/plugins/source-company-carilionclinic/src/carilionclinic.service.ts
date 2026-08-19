import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Carilion Clinic — Not-for-profit integrated health system serving southwest Virginia.
 *
 * Carilion Clinic is a not-for-profit integrated health care organization
 * serving communities in southwest Virginia through hospitals, physician
 * practices, and outpatient services. It is affiliated with the Virginia
 * Tech Carilion School of Medicine.
 *
 * Sector: Healthcare / Hospital System. HQ: Roanoke, Virginia, USA.
 *
 * Source: SmartRecruiters job board, company identifier `CarilionClinic`
 * (`https://jobs.smartrecruiters.com/CarilionClinic`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CarilionClinic';
const COMPANY_NAME = 'Carilion Clinic';

@SourcePlugin({
  site: Site.CARILION_CLINIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CarilionClinicService implements IScraper {
  private readonly logger = new Logger(CarilionClinicService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Carilion Clinic',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Carilion Clinic: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CARILION_CLINIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'carilionclinic-');
      }
    }

    this.logger.log(`Carilion Clinic: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
