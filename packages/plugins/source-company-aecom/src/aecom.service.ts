import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * AECOM — Global infrastructure consulting firm with an extensive renewable energy and power practice.
 *
 * AECOM is a global infrastructure consulting firm providing engineering and
 * advisory services. Its energy work spans solar PV, onshore and offshore
 * wind, hydropower, microgrids, battery storage and transmission and
 * distribution infrastructure.
 *
 * Sector: Energy & Infrastructure Engineering. HQ: Dallas, Texas, United States.
 *
 * Source: SmartRecruiters job board, company identifier `AECOM2`
 * (`https://jobs.smartrecruiters.com/AECOM2`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AECOM2';
const COMPANY_NAME = 'AECOM';

@SourcePlugin({
  site: Site.AECOM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AECOMService implements IScraper {
  private readonly logger = new Logger(AECOMService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape AECOM',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `AECOM: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AECOM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'aecom-');
      }
    }

    this.logger.log(`AECOM: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
