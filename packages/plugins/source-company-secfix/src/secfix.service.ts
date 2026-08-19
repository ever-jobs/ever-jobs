import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Secfix — Security compliance automation platform for European companies.
 *
 * Secfix automates security compliance, helping companies achieve and
 * maintain certifications such as ISO 27001, SOC 2, GDPR, and TISAX. It
 * focuses on reducing the manual effort involved in compliance programs,
 * with an emphasis on the European market.
 *
 * Sector: Security Compliance. HQ: Munich, Bavaria, Germany.
 *
 * Source: Ashby job board, company slug `secfix`
 * (`https://jobs.ashbyhq.com/secfix`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'secfix';
const COMPANY_NAME = 'Secfix';

@SourcePlugin({
  site: Site.SECFIX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SecfixService implements IScraper {
  private readonly logger = new Logger(SecfixService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Secfix',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Secfix: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SECFIX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'secfix-');
      }
    }

    this.logger.log(`Secfix: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
