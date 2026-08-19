import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Trusted Shops — E-commerce trust platform offering trustmarks, buyer protection, and reviews.
 *
 * Trusted Shops SE operates a SaaS platform for e-commerce that builds
 * digital trust through its Trustmark, buyer-protection services, and review
 * products, serving a large community of consumers and merchants.
 *
 * Sector: E-commerce SaaS. HQ: Cologne, Germany.
 *
 * Source: Recruitee careers board, subdomain `trustedshops`
 * (`https://trustedshops.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'trustedshops';
const COMPANY_NAME = 'Trusted Shops';

@SourcePlugin({
  site: Site.TRUSTED_SHOPS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TrustedShopsService implements IScraper {
  private readonly logger = new Logger(TrustedShopsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Trusted Shops',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Trusted Shops: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRUSTED_SHOPS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'trustedshops-');
      }
    }

    this.logger.log(`Trusted Shops: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
