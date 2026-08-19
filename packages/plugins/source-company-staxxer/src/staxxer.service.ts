import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Staxxer — Software for VAT compliance and financial administration for European e-commerce sellers.
 *
 * Staxxer is a Dutch software company offering a platform for European VAT
 * compliance, registrations, and financial administration aimed at
 * cross-border e-commerce sellers. It hires backend developers and
 * accounting/admin staff.
 *
 * Sector: Fintech / tax-compliance SaaS. HQ: Rotterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `staxxer`
 * (`https://staxxer.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'staxxer';
const COMPANY_NAME = 'Staxxer';

@SourcePlugin({
  site: Site.STAXXER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StaxxerService implements IScraper {
  private readonly logger = new Logger(StaxxerService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Staxxer',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Staxxer: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STAXXER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'staxxer-');
      }
    }

    this.logger.log(`Staxxer: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
