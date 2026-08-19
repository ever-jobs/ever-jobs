import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Expeditors — Global logistics and freight forwarding company providing supply chain services.
 *
 * Expeditors International is a global logistics company headquartered in
 * Seattle, offering air and ocean freight forwarding, customs brokerage,
 * warehousing, and supply chain solutions. It operates a worldwide network
 * of offices across six continents.
 *
 * Sector: Logistics. HQ: Seattle, Washington, United States.
 *
 * Source: SmartRecruiters job board, company identifier `Expeditors`
 * (`https://jobs.smartrecruiters.com/Expeditors`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Expeditors';
const COMPANY_NAME = 'Expeditors';

@SourcePlugin({
  site: Site.EXPEDITORS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ExpeditorsService implements IScraper {
  private readonly logger = new Logger(ExpeditorsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Expeditors',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Expeditors: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EXPEDITORS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'expeditors-');
      }
    }

    this.logger.log(`Expeditors: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
