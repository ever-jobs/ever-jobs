import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Deloitte New Zealand — New Zealand member firm of Deloitte, serving government and commercial clients.
 *
 * Deloitte New Zealand is the New Zealand member firm of the global Deloitte
 * network, providing audit, consulting, tax, and advisory services. It
 * includes a government and public services practice that works with
 * public-sector clients on operational and transformation projects, and
 * hires across professional-services disciplines.
 *
 * Sector: Government contractors / public sector (professional services). HQ: Auckland, New Zealand.
 *
 * Source: SmartRecruiters job board, company identifier `DeloitteNZ`
 * (`https://jobs.smartrecruiters.com/DeloitteNZ`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'DeloitteNZ';
const COMPANY_NAME = 'Deloitte New Zealand';

@SourcePlugin({
  site: Site.DELOITTE_NEW_ZEALAND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DeloitteNewZealandService implements IScraper {
  private readonly logger = new Logger(DeloitteNewZealandService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Deloitte New Zealand',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Deloitte New Zealand: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELOITTE_NEW_ZEALAND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'deloittenewzealand-');
      }
    }

    this.logger.log(`Deloitte New Zealand: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
