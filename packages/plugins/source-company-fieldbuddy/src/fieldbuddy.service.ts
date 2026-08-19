import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * FieldBuddy — Field service management software for planning and executing on-site service work.
 *
 * FieldBuddy is a Dutch software company providing a field service
 * management platform used to plan, dispatch, and execute on-site service
 * and maintenance work. It operates from Amsterdam with development in
 * Etten-Leur, Noord-Brabant.
 *
 * Sector: Field service management SaaS. HQ: Amsterdam / Etten-Leur, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `fieldbuddy`
 * (`https://fieldbuddy.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'fieldbuddy';
const COMPANY_NAME = 'FieldBuddy';

@SourcePlugin({
  site: Site.FIELDBUDDY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FieldBuddyService implements IScraper {
  private readonly logger = new Logger(FieldBuddyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape FieldBuddy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `FieldBuddy: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIELDBUDDY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'fieldbuddy-');
      }
    }

    this.logger.log(`FieldBuddy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
