import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CRB — Engineering, architecture, and construction firm serving life sciences and advanced technology facilities.
 *
 * CRB is a provider of sustainable engineering, architecture, construction,
 * and consulting services. It focuses on the life sciences and advanced
 * technology industries, delivering facilities for pharmaceutical, biotech,
 * and food and beverage clients. The company is headquartered in Kansas
 * City, Missouri.
 *
 * Sector: Engineering, Architecture & Construction. HQ: Kansas City, Missouri, USA.
 *
 * Source: SmartRecruiters job board, company identifier `CRB`
 * (`https://jobs.smartrecruiters.com/CRB`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CRB';
const COMPANY_NAME = 'CRB';

@SourcePlugin({
  site: Site.CRB,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CRBService implements IScraper {
  private readonly logger = new Logger(CRBService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape CRB',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `CRB: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CRB;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'crb-');
      }
    }

    this.logger.log(`CRB: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
