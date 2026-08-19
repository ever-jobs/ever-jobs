import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fun.xyz — Web3 payments and onchain infrastructure company building crypto developer tooling.
 *
 * Fun.xyz builds Web3 payments infrastructure and developer tooling that
 * spans multiple blockchain ecosystems including Ethereum, Solana, and Layer
 * 2 networks.
 *
 * Sector: Web3 Infrastructure. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `funxyz`
 * (`https://jobs.lever.co/funxyz`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'funxyz';
const COMPANY_NAME = 'Fun.xyz';

@SourcePlugin({
  site: Site.FUN_XYZ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FunXyzService implements IScraper {
  private readonly logger = new Logger(FunXyzService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Fun.xyz',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fun.xyz: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FUN_XYZ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'funxyz-');
      }
    }

    this.logger.log(`Fun.xyz: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
