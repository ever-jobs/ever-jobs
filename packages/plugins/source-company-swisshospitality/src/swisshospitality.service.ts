import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Swiss Hospitality — Hospitality management company operating hotel and service businesses.
 *
 * Swiss Hospitality is a hospitality management company that operates and
 * supports hotel and hospitality service businesses. It recruits for roles
 * across hotel operations and guest services.
 *
 * Sector: Hospitality. HQ: Switzerland.
 *
 * Source: SmartRecruiters job board, company identifier `SwissHospitality`
 * (`https://jobs.smartrecruiters.com/SwissHospitality`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SwissHospitality';
const COMPANY_NAME = 'Swiss Hospitality';

@SourcePlugin({
  site: Site.SWISS_HOSPITALITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SwissHospitalityService implements IScraper {
  private readonly logger = new Logger(SwissHospitalityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Swiss Hospitality',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Swiss Hospitality: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SWISS_HOSPITALITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'swisshospitality-');
      }
    }

    this.logger.log(`Swiss Hospitality: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
