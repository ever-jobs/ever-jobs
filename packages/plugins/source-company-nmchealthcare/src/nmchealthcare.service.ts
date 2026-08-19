import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * NMC Healthcare — Private healthcare provider operating hospitals and clinics across the UAE and wider region.
 *
 * NMC Healthcare is a private healthcare operator running hospitals, medical
 * centres, and clinics across the United Arab Emirates and other markets. It
 * provides multi-specialty inpatient and outpatient medical services.
 *
 * Sector: Healthcare / Hospital System. HQ: Abu Dhabi, United Arab Emirates.
 *
 * Source: SmartRecruiters job board, company identifier `NMCHealthcare`
 * (`https://jobs.smartrecruiters.com/NMCHealthcare`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'NMCHealthcare';
const COMPANY_NAME = 'NMC Healthcare';

@SourcePlugin({
  site: Site.NMC_HEALTHCARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NMCHealthcareService implements IScraper {
  private readonly logger = new Logger(NMCHealthcareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape NMC Healthcare',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `NMC Healthcare: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NMC_HEALTHCARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'nmchealthcare-');
      }
    }

    this.logger.log(`NMC Healthcare: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
