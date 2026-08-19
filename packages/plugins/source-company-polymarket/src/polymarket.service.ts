import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Polymarket — Onchain prediction market platform where users trade on real-world event outcomes.
 *
 * Polymarket operates an onchain prediction market where users trade on the
 * outcomes of real-world events. Its systems sit between the product and the
 * blockchain, handling distributed systems and high-throughput backend work.
 * The platform settles trades onchain.
 *
 * Sector: Onchain prediction markets. HQ: New York, New York, United States.
 *
 * Source: Ashby job board, company slug `polymarket`
 * (`https://jobs.ashbyhq.com/polymarket`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'polymarket';
const COMPANY_NAME = 'Polymarket';

@SourcePlugin({
  site: Site.POLYMARKET,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PolymarketService implements IScraper {
  private readonly logger = new Logger(PolymarketService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Polymarket',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Polymarket: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.POLYMARKET;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'polymarket-');
      }
    }

    this.logger.log(`Polymarket: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
