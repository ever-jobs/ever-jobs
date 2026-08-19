import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Binance — Global cryptocurrency exchange and blockchain infrastructure ecosystem.
 *
 * Binance operates a large cryptocurrency exchange and a broader blockchain
 * ecosystem covering spot and derivatives trading, wallets, a Web3 layer,
 * and its Binance Accelerator Program for early-career talent.
 *
 * Sector: Crypto / Digital Assets. HQ: Global (no single HQ), Global.
 *
 * Source: Lever job board, company slug `binance`
 * (`https://jobs.lever.co/binance`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'binance';
const COMPANY_NAME = 'Binance';

@SourcePlugin({
  site: Site.BINANCE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BinanceService implements IScraper {
  private readonly logger = new Logger(BinanceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Binance',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Binance: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BINANCE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'binance-');
      }
    }

    this.logger.log(`Binance: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
