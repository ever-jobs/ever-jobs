import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Learned — HR software platform for performance management, reviews, and employee development.
 *
 * Learned is a Utrecht-based HR SaaS company whose platform supports
 * performance management, reviews, goal-setting, and employee development.
 * Its stack spans React front ends and Node.js back-end services.
 *
 * Sector: HR-tech SaaS. HQ: Utrecht, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `learned`
 * (`https://learned.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'learned';
const COMPANY_NAME = 'Learned';

@SourcePlugin({
  site: Site.LEARNED,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LearnedService implements IScraper {
  private readonly logger = new Logger(LearnedService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Learned',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Learned: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LEARNED;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'learned-');
      }
    }

    this.logger.log(`Learned: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
