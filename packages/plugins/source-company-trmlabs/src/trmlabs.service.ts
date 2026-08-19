import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * TRM Labs — Blockchain intelligence platform for detecting and investigating crypto-related crime.
 *
 * TRM Labs provides blockchain analytics and intelligence solutions that
 * help financial institutions and public agencies detect, investigate, and
 * disrupt crypto-related financial crime. Its platform supports threat
 * intelligence and transaction risk analysis.
 *
 * Sector: Blockchain intelligence / risk. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `trm-labs`
 * (`https://jobs.ashbyhq.com/trm-labs`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'trm-labs';
const COMPANY_NAME = 'TRM Labs';

@SourcePlugin({
  site: Site.TRM_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TRMLabsService implements IScraper {
  private readonly logger = new Logger(TRMLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape TRM Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `TRM Labs: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRM_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'trmlabs-');
      }
    }

    this.logger.log(`TRM Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
