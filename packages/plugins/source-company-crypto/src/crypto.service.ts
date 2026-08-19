import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Crypto.com — Cryptocurrency exchange and financial-services platform for retail and institutional users.
 *
 * Crypto.com operates a cryptocurrency exchange and financial-services
 * platform offering trading, payments, and related digital-asset products to
 * retail and institutional customers globally. It was founded in 2016.
 *
 * Sector: Crypto / Fintech. HQ: Singapore, Singapore.
 *
 * Source: Lever job board, company slug `crypto`
 * (`https://jobs.lever.co/crypto`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'crypto';
const COMPANY_NAME = 'Crypto.com';

@SourcePlugin({
  site: Site.CRYPTO_COM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CryptoComService implements IScraper {
  private readonly logger = new Logger(CryptoComService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Crypto.com',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Crypto.com: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CRYPTO_COM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'crypto-');
      }
    }

    this.logger.log(`Crypto.com: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
