import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Trust Wallet — Non-custodial cryptocurrency wallet supporting multiple blockchains and assets.
 *
 * Trust Wallet is a non-custodial cryptocurrency wallet used to store and
 * manage digital assets. It supports many assets across a range of
 * blockchains. The product targets self-custody for retail crypto users.
 *
 * Sector: Crypto wallet. HQ: Singapore.
 *
 * Source: Ashby job board, company slug `trust-wallet`
 * (`https://jobs.ashbyhq.com/trust-wallet`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'trust-wallet';
const COMPANY_NAME = 'Trust Wallet';

@SourcePlugin({
  site: Site.TRUST_WALLET,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TrustWalletService implements IScraper {
  private readonly logger = new Logger(TrustWalletService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Trust Wallet',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Trust Wallet: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRUST_WALLET;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'trustwallet-');
      }
    }

    this.logger.log(`Trust Wallet: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
