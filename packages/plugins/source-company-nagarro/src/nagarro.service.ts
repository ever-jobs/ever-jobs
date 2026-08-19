import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Nagarro — Global digital engineering and IT services company serving public-sector and commercial clients.
 *
 * Nagarro is a global digital engineering and IT services company that
 * builds software and digital products for clients across industries,
 * including a State, Local Government, Non-Profit and Education (SLED)
 * public-sector segment. It hires engineers, consultants, and account roles
 * worldwide.
 *
 * Sector: Government contractors / public sector (digital engineering and IT services). HQ: Munich, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `Nagarro1`
 * (`https://jobs.smartrecruiters.com/Nagarro1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Nagarro1';
const COMPANY_NAME = 'Nagarro';

@SourcePlugin({
  site: Site.NAGARRO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NagarroService implements IScraper {
  private readonly logger = new Logger(NagarroService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Nagarro',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Nagarro: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NAGARRO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'nagarro-');
      }
    }

    this.logger.log(`Nagarro: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
