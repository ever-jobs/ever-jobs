import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ethena Labs — DeFi protocol building the USDe synthetic dollar and stablecoin infrastructure.
 *
 * Ethena Labs develops the USDe synthetic dollar and related stablecoin
 * infrastructure, including whitelabel stablecoin offerings for
 * applications, chains, wallets, and exchanges.
 *
 * Sector: DeFi / Stablecoins. HQ: Remote, Global.
 *
 * Source: Lever job board, company slug `ethenalabs`
 * (`https://jobs.lever.co/ethenalabs`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'ethenalabs';
const COMPANY_NAME = 'Ethena Labs';

@SourcePlugin({
  site: Site.ETHENA_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EthenaLabsService implements IScraper {
  private readonly logger = new Logger(EthenaLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Ethena Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ethena Labs: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ETHENA_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'ethenalabs-');
      }
    }

    this.logger.log(`Ethena Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
