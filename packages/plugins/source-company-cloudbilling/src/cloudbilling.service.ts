import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CloudBilling — Naarden-based Dutch SaaS company providing flexible billing, invoicing and monetization software.
 *
 * CloudBilling B.V. is a Dutch software company based in Naarden that
 * provides configurable billing, rating and invoicing software used to
 * monetize products and services. Its Recruitee careers site
 * (cloudbilling.recruitee.com) listed four live openings, with the company
 * describing itself as a growing Dutch tech company in billing and
 * business-intelligence.
 *
 * Sector: Billing / monetization SaaS. HQ: Naarden, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `cloudbilling`
 * (`https://cloudbilling.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'cloudbilling';
const COMPANY_NAME = 'CloudBilling';

@SourcePlugin({
  site: Site.CLOUDBILLING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CloudBillingService implements IScraper {
  private readonly logger = new Logger(CloudBillingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape CloudBilling',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `CloudBilling: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CLOUDBILLING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'cloudbilling-');
      }
    }

    this.logger.log(`CloudBilling: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
