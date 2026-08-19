import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Experian — Global data and technology company providing credit and analytics services.
 *
 * Experian is a data, analytics, and technology company operating in credit
 * reporting, decisioning, fraud prevention, and marketing analytics. It
 * builds enterprise software and cloud platforms serving financial services
 * and businesses worldwide. It operates across the Americas, EMEA, and Asia
 * Pacific.
 *
 * Sector: Data, analytics and technology services. HQ: Dublin, Ireland.
 *
 * Source: SmartRecruiters job board, company identifier `Experian`
 * (`https://jobs.smartrecruiters.com/Experian`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Experian';
const COMPANY_NAME = 'Experian';

@SourcePlugin({
  site: Site.EXPERIAN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ExperianService implements IScraper {
  private readonly logger = new Logger(ExperianService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Experian',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Experian: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EXPERIAN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'experian-');
      }
    }

    this.logger.log(`Experian: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
