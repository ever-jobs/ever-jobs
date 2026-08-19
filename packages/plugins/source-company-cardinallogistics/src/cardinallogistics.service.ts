import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cardinal Logistics — US dedicated trucking and transportation logistics provider.
 *
 * Cardinal Logistics is a US-based transportation and logistics company
 * headquartered in Concord, North Carolina. It operates one of the country's
 * larger dedicated fleets, providing dedicated contract carriage, freight
 * brokerage, and supply chain services throughout the United States.
 *
 * Sector: Logistics & Trucking. HQ: Concord, North Carolina, United States.
 *
 * Source: SmartRecruiters job board, company identifier `CardinalLogistics1`
 * (`https://jobs.smartrecruiters.com/CardinalLogistics1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CardinalLogistics1';
const COMPANY_NAME = 'Cardinal Logistics';

@SourcePlugin({
  site: Site.CARDINAL_LOGISTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CardinalLogisticsService implements IScraper {
  private readonly logger = new Logger(CardinalLogisticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Cardinal Logistics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cardinal Logistics: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CARDINAL_LOGISTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cardinallogistics-');
      }
    }

    this.logger.log(`Cardinal Logistics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
