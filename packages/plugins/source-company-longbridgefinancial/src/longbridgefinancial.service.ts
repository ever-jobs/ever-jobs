import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Longbridge Financial — US lender specializing in reverse mortgages and home equity products for seniors.
 *
 * Longbridge Financial is a US mortgage lender specializing in reverse
 * mortgages and home equity products aimed at older homeowners. It
 * originates and services these loans across multiple states.
 *
 * Sector: Financial services / mortgage lending. HQ: Mahwah, New Jersey, USA.
 *
 * Source: SmartRecruiters job board, company identifier `LongbridgeFinancial`
 * (`https://jobs.smartrecruiters.com/LongbridgeFinancial`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'LongbridgeFinancial';
const COMPANY_NAME = 'Longbridge Financial';

@SourcePlugin({
  site: Site.LONGBRIDGE_FINANCIAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LongbridgeFinancialService implements IScraper {
  private readonly logger = new Logger(LongbridgeFinancialService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Longbridge Financial',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Longbridge Financial: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LONGBRIDGE_FINANCIAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'longbridgefinancial-');
      }
    }

    this.logger.log(`Longbridge Financial: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
