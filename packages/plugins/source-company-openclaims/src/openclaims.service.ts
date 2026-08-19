import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Openclaims — SaaS platform for managing and optimizing vehicle damage repair processes for insurers and fleets.
 *
 * Openclaims is an Amsterdam-based insurtech company offering a SaaS
 * platform that helps insurers, leasing companies, and fleet owners manage
 * and optimize the vehicle damage repair process. Its stack spans Mendix,
 * React, Java, and Python.
 *
 * Sector: Insurtech SaaS. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `openclaims`
 * (`https://openclaims.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'openclaims';
const COMPANY_NAME = 'Openclaims';

@SourcePlugin({
  site: Site.OPENCLAIMS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OpenclaimsService implements IScraper {
  private readonly logger = new Logger(OpenclaimsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Openclaims',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Openclaims: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OPENCLAIMS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'openclaims-');
      }
    }

    this.logger.log(`Openclaims: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
