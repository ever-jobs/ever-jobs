import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Taptap Send — A cross-border money transfer app focused on emerging markets.
 *
 * Taptap Send is a cross-border remittance company that enables people to
 * send money internationally, with a focus on emerging markets. It operates
 * across multiple continents and is exploring stablecoin-based money
 * movement.
 *
 * Sector: Fintech - Cross-border remittance. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `taptapsend`
 * (`https://jobs.ashbyhq.com/taptapsend`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'taptapsend';
const COMPANY_NAME = 'Taptap Send';

@SourcePlugin({
  site: Site.TAPTAP_SEND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TaptapSendService implements IScraper {
  private readonly logger = new Logger(TaptapSendService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Taptap Send',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Taptap Send: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TAPTAP_SEND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'taptapsend-');
      }
    }

    this.logger.log(`Taptap Send: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
