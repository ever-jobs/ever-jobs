import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Avaloq — Provider of banking and wealth management software and services for financial institutions.
 *
 * Avaloq develops core banking and wealth management technology used by
 * private banks, wealth managers, and other financial institutions. It
 * offers both software licensing and business process outsourcing. Avaloq is
 * part of NEC Corporation.
 *
 * Sector: Fintech / wealth management technology. HQ: Zurich, Switzerland.
 *
 * Source: SmartRecruiters job board, company identifier `Avaloq1`
 * (`https://jobs.smartrecruiters.com/Avaloq1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Avaloq1';
const COMPANY_NAME = 'Avaloq';

@SourcePlugin({
  site: Site.AVALOQ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AvaloqService implements IScraper {
  private readonly logger = new Logger(AvaloqService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Avaloq',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Avaloq: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AVALOQ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'avaloq-');
      }
    }

    this.logger.log(`Avaloq: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
