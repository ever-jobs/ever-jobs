import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Nmbrs — Cloud HR and payroll software for accountants and businesses.
 *
 * Nmbrs is an Amsterdam-based scale-up providing cloud HR and payroll
 * software used by accountants and businesses to manage payroll and HR
 * administration. It hires across sales, implementation, data, and product
 * roles.
 *
 * Sector: HR / payroll SaaS. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `nmbrs`
 * (`https://nmbrs.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'nmbrs';
const COMPANY_NAME = 'Nmbrs';

@SourcePlugin({
  site: Site.NMBRS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NmbrsService implements IScraper {
  private readonly logger = new Logger(NmbrsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Nmbrs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Nmbrs: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NMBRS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'nmbrs-');
      }
    }

    this.logger.log(`Nmbrs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
