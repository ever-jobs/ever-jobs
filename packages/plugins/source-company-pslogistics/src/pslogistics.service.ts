import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * PS Logistics — US flatbed trucking and third-party logistics provider.
 *
 * PS Logistics is a US-based flatbed transportation and third-party
 * logistics provider headquartered in Birmingham, Alabama. It offers
 * dedicated trucking, warehousing, and brokerage services across the United
 * States through a family of logistics brands.
 *
 * Sector: Logistics & Trucking. HQ: Birmingham, Alabama, United States.
 *
 * Source: SmartRecruiters job board, company identifier `PSLogistics`
 * (`https://jobs.smartrecruiters.com/PSLogistics`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'PSLogistics';
const COMPANY_NAME = 'PS Logistics';

@SourcePlugin({
  site: Site.PS_LOGISTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PSLogisticsService implements IScraper {
  private readonly logger = new Logger(PSLogisticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape PS Logistics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `PS Logistics: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PS_LOGISTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'pslogistics-');
      }
    }

    this.logger.log(`PS Logistics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
