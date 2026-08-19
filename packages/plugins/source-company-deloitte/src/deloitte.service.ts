import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deloitte — Global professional services network providing audit, tax, consulting, risk and advisory services.
 *
 * Deloitte is one of the largest global professional services organizations,
 * delivering audit and assurance, tax and legal, consulting, and risk and
 * financial advisory services. It operates through member firms across
 * numerous countries. This SmartRecruiters board hosts postings including
 * graduate and consulting recruitment across regions.
 *
 * Sector: Professional services / consulting. HQ: London, England, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `Deloitte6`
 * (`https://jobs.smartrecruiters.com/Deloitte6`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Deloitte6';
const COMPANY_NAME = 'Deloitte';

@SourcePlugin({
  site: Site.DELOITTE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeloitteService implements IScraper {
  private readonly logger = new Logger(DeloitteService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Deloitte',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deloitte: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELOITTE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deloitte-');
      }
    }

    this.logger.log(`Deloitte: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
