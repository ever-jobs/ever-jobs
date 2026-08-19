import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Relief International — Humanitarian non-profit working in fragile settings across roughly 20 countries.
 *
 * Relief International is a non-profit humanitarian organization that works
 * in fragile and crisis-affected settings across roughly 20 countries. It
 * delivers health, education, economic opportunity, and emergency-response
 * programs and hires field and headquarters staff as well as interns.
 *
 * Sector: Non-profit (humanitarian / international development). HQ: Washington, D.C., USA.
 *
 * Source: SmartRecruiters job board, company identifier `ReliefInternational`
 * (`https://jobs.smartrecruiters.com/ReliefInternational`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ReliefInternational';
const COMPANY_NAME = 'Relief International';

@SourcePlugin({
  site: Site.RELIEF_INTERNATIONAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ReliefInternationalService implements IScraper {
  private readonly logger = new Logger(ReliefInternationalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Relief International',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Relief International: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RELIEF_INTERNATIONAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'reliefinternational-');
      }
    }

    this.logger.log(`Relief International: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
