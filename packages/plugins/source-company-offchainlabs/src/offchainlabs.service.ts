import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Offchain Labs — Ethereum scaling company and developer of the Arbitrum Layer 2 rollup ecosystem.
 *
 * Offchain Labs builds Ethereum Layer 2 scaling technology, including the
 * Arbitrum optimistic rollup stack and related developer tooling for
 * decentralized applications.
 *
 * Sector: Blockchain / Layer 2. HQ: New York, New York, United States.
 *
 * Source: Lever job board, company slug `offchainlabs`
 * (`https://jobs.lever.co/offchainlabs`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'offchainlabs';
const COMPANY_NAME = 'Offchain Labs';

@SourcePlugin({
  site: Site.OFFCHAIN_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OffchainLabsService implements IScraper {
  private readonly logger = new Logger(OffchainLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Offchain Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Offchain Labs: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OFFCHAIN_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'offchainlabs-');
      }
    }

    this.logger.log(`Offchain Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
