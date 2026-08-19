import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Online Payment Platform (OPP) — Delft-based payment service provider specializing in marketplace and platform payments with escrow-style flows.
 *
 * Online Payment Platform (OPP) is a Dutch payment service provider based in
 * Delft, focused on split payments, escrow-style holding and payouts for
 * online marketplaces and platforms. Its Recruitee board
 * (onlinepaymentplatform.recruitee.com) listed finance, compliance and
 * engineering roles including backend (PHP), DevOps/SRE and data
 * engineering, all based in Delft. Note: the shorter slug opp.recruitee.com
 * returns empty; the verified board is onlinepaymentplatform.
 *
 * Sector: Payments / PSP for marketplaces. HQ: Delft, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `onlinepaymentplatform`
 * (`https://onlinepaymentplatform.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'onlinepaymentplatform';
const COMPANY_NAME = 'Online Payment Platform (OPP)';

@SourcePlugin({
  site: Site.ONLINE_PAYMENT_PLATFORM_OPP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OnlinePaymentPlatformOPPService implements IScraper {
  private readonly logger = new Logger(OnlinePaymentPlatformOPPService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Online Payment Platform (OPP)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Online Payment Platform (OPP): delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ONLINE_PAYMENT_PLATFORM_OPP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'onlinepaymentplatformopp-');
      }
    }

    this.logger.log(`Online Payment Platform (OPP): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
