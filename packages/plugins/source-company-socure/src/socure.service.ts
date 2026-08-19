import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Socure — Digital identity verification and fraud-prevention platform powered by predictive analytics and machine learning.
 *
 * Socure builds identity verification and fraud-prevention technology using
 * predictive analytics and machine learning trained on large volumes of
 * signals. Its RiskOS platform supports identity verification, KYC, and
 * fraud detection for financial services and other sectors.
 *
 * Sector: Identity Verification & Fraud. HQ: Incline Village, Nevada, United States.
 *
 * Source: Ashby job board, company slug `socure`
 * (`https://jobs.ashbyhq.com/socure`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'socure';
const COMPANY_NAME = 'Socure';

@SourcePlugin({
  site: Site.SOCURE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SocureService implements IScraper {
  private readonly logger = new Logger(SocureService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Socure',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Socure: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SOCURE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'socure-');
      }
    }

    this.logger.log(`Socure: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
