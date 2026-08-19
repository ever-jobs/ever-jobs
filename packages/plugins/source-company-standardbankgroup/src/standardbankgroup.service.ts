import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Standard Bank Group — Africa\'s largest bank by assets, offering retail, business, and corporate banking.
 *
 * Standard Bank Group is a financial services group headquartered in South
 * Africa, operating across many African countries and select global markets.
 * It provides personal and business banking, corporate and investment
 * banking, and wealth and insurance services. It is Africa's largest bank by
 * assets.
 *
 * Sector: Banking / financial services. HQ: Johannesburg, Gauteng, South Africa.
 *
 * Source: SmartRecruiters job board, company identifier `StandardBankGroup`
 * (`https://jobs.smartrecruiters.com/StandardBankGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'StandardBankGroup';
const COMPANY_NAME = 'Standard Bank Group';

@SourcePlugin({
  site: Site.STANDARD_BANK_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StandardBankGroupService implements IScraper {
  private readonly logger = new Logger(StandardBankGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Standard Bank Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Standard Bank Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STANDARD_BANK_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'standardbankgroup-');
      }
    }

    this.logger.log(`Standard Bank Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
