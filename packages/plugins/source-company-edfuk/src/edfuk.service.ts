import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * EDF UK — UK arm of EDF, a low-carbon electricity generator and supplier spanning nuclear and renewables.
 *
 * EDF UK is the British subsidiary of EDF, generating and supplying
 * electricity across the UK and Ireland. Its portfolio includes nuclear
 * generation alongside onshore and offshore wind, solar, battery storage and
 * green hydrogen projects.
 *
 * Sector: Energy Utility. HQ: London, England, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `EDF-UK`
 * (`https://jobs.smartrecruiters.com/EDF-UK`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'EDF-UK';
const COMPANY_NAME = 'EDF UK';

@SourcePlugin({
  site: Site.EDF_UK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EDFUKService implements IScraper {
  private readonly logger = new Logger(EDFUKService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape EDF UK',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `EDF UK: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EDF_UK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'edfuk-');
      }
    }

    this.logger.log(`EDF UK: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
