import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Stargate Foundation — Cross-chain liquidity infrastructure protocol built on LayerZero.
 *
 * Stargate Foundation supports Stargate, a cross-chain liquidity
 * infrastructure protocol built on LayerZero. It enables asset transfers and
 * settlement across multiple blockchains. The protocol focuses on
 * cross-chain liquidity.
 *
 * Sector: Cross-chain liquidity protocol. HQ: Remote.
 *
 * Source: Ashby job board, company slug `stargate-foundation`
 * (`https://jobs.ashbyhq.com/stargate-foundation`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'stargate-foundation';
const COMPANY_NAME = 'Stargate Foundation';

@SourcePlugin({
  site: Site.STARGATE_FOUNDATION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StargateFoundationService implements IScraper {
  private readonly logger = new Logger(StargateFoundationService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Stargate Foundation',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Stargate Foundation: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STARGATE_FOUNDATION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'stargatefoundation-');
      }
    }

    this.logger.log(`Stargate Foundation: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
