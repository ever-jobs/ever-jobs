import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Freshworks — SaaS provider of customer service and IT service management software.
 *
 * Freshworks develops cloud-based business software for customer support,
 * sales, marketing, and IT service management. Its products include
 * Freshdesk and Freshservice. The company serves businesses of varying sizes
 * and is publicly traded.
 *
 * Sector: Enterprise SaaS (customer and employee software). HQ: San Mateo, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Freshworks`
 * (`https://jobs.smartrecruiters.com/Freshworks`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Freshworks';
const COMPANY_NAME = 'Freshworks';

@SourcePlugin({
  site: Site.FRESHWORKS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FreshworksService implements IScraper {
  private readonly logger = new Logger(FreshworksService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Freshworks',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Freshworks: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FRESHWORKS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'freshworks-');
      }
    }

    this.logger.log(`Freshworks: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
