import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Assent — Supply chain sustainability management software provider.
 *
 * Assent provides a software platform for supply chain sustainability and
 * regulatory compliance management, focused on complex manufacturers. Its
 * tools help companies track product compliance, ESG, and trade
 * requirements. It serves industrial and manufacturing enterprises.
 *
 * Sector: Enterprise SaaS (supply chain sustainability). HQ: Ottawa, Ontario, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `Assent`
 * (`https://jobs.smartrecruiters.com/Assent`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Assent';
const COMPANY_NAME = 'Assent';

@SourcePlugin({
  site: Site.ASSENT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AssentService implements IScraper {
  private readonly logger = new Logger(AssentService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Assent',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Assent: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASSENT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'assent-');
      }
    }

    this.logger.log(`Assent: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
