import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Unit4 — Enterprise resource planning (ERP) software provider.
 *
 * Unit4 develops cloud-based enterprise resource planning software,
 * including ERP, financials, HCM, and professional services automation. Its
 * products target mid-market and people-centric service organizations. It
 * operates internationally.
 *
 * Sector: Enterprise software (ERP). HQ: Utrecht, Netherlands.
 *
 * Source: SmartRecruiters job board, company identifier `unit44`
 * (`https://jobs.smartrecruiters.com/unit44`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'unit44';
const COMPANY_NAME = 'Unit4';

@SourcePlugin({
  site: Site.UNIT4,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class Unit4Service implements IScraper {
  private readonly logger = new Logger(Unit4Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Unit4',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Unit4: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UNIT4;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'unit4-');
      }
    }

    this.logger.log(`Unit4: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
