import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Chainalysis — Blockchain data platform for compliance, investigation, and risk analysis.
 *
 * Chainalysis provides blockchain data and analytics used by government
 * agencies and businesses to investigate and manage risk in cryptocurrency.
 * Its products support compliance, investigations, and transaction
 * monitoring. It has offices in multiple locations including New York and
 * Tel Aviv.
 *
 * Sector: Blockchain analytics / compliance. HQ: New York, New York, United States.
 *
 * Source: Ashby job board, company slug `chainalysis-careers`
 * (`https://jobs.ashbyhq.com/chainalysis-careers`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'chainalysis-careers';
const COMPANY_NAME = 'Chainalysis';

@SourcePlugin({
  site: Site.CHAINALYSIS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ChainalysisService implements IScraper {
  private readonly logger = new Logger(ChainalysisService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Chainalysis',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Chainalysis: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CHAINALYSIS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'chainalysis-');
      }
    }

    this.logger.log(`Chainalysis: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
