import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Wise — Technology company building cross-border money movement infrastructure.
 *
 * Wise is a financial technology company that builds software and
 * infrastructure for international money transfers and multi-currency
 * accounts. It operates its own payments platform and engineering
 * organization. The company is publicly traded.
 *
 * Sector: Financial technology (fintech). HQ: London, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `Wise`
 * (`https://jobs.smartrecruiters.com/Wise`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Wise';
const COMPANY_NAME = 'Wise';

@SourcePlugin({
  site: Site.WISE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WiseService implements IScraper {
  private readonly logger = new Logger(WiseService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Wise',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Wise: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WISE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'wise-');
      }
    }

    this.logger.log(`Wise: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
