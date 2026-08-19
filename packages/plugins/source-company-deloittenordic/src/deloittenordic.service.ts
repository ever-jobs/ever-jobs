import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deloitte (Nordic) — Deloitte\'s Nordic professional-services organisation covering audit, tax, consulting and advisory.
 *
 * This SmartRecruiters careers site covers Deloitte's Nordic member-firm
 * organisation, spanning Denmark, Sweden, Norway, Finland and Iceland.
 * Deloitte provides audit and assurance, tax, consulting, risk and financial
 * advisory services to organisations across the region.
 *
 * Sector: Professional services (audit, tax, consulting, advisory). HQ: Copenhagen, Denmark (Nordic region).
 *
 * Source: SmartRecruiters job board, company identifier `DeloitteNordic`
 * (`https://jobs.smartrecruiters.com/DeloitteNordic`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'DeloitteNordic';
const COMPANY_NAME = 'Deloitte (Nordic)';

@SourcePlugin({
  site: Site.DELOITTE_NORDIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeloitteNordicService implements IScraper {
  private readonly logger = new Logger(DeloitteNordicService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Deloitte (Nordic)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deloitte (Nordic): delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELOITTE_NORDIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deloittenordic-');
      }
    }

    this.logger.log(`Deloitte (Nordic): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
