import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Coins.ph — Southeast Asian cryptocurrency exchange and digital wallet for payments and remittances.
 *
 * Coins.ph provides a licensed cryptocurrency exchange, digital wallet, and
 * payments platform in the Philippines, supporting crypto trading, bill
 * payments, remittances, and local payment rails.
 *
 * Sector: Crypto / Digital Assets. HQ: Manila, Metro Manila, Philippines.
 *
 * Source: Lever job board, company slug `coins`
 * (`https://jobs.lever.co/coins`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'coins';
const COMPANY_NAME = 'Coins.ph';

@SourcePlugin({
  site: Site.COINS_PH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CoinsPhService implements IScraper {
  private readonly logger = new Logger(CoinsPhService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Coins.ph',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Coins.ph: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COINS_PH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'coins-');
      }
    }

    this.logger.log(`Coins.ph: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
