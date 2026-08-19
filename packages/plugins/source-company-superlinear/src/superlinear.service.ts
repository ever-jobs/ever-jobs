import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Superlinear — AI and optimization consultancy building enterprise orchestration technology.
 *
 * Superlinear is a Brussels-based AI, data, and optimization technology
 * company. Its Recruitee board at superlinear.recruitee.com listed 6 offers,
 * all Brussels-based, including several forward-deployed engineer roles
 * (cloud, data, optimization).
 *
 * Sector: Software / AI consultancy. HQ: Brussels, Belgium.
 *
 * Source: Recruitee careers board, subdomain `superlinear`
 * (`https://superlinear.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'superlinear';
const COMPANY_NAME = 'Superlinear';

@SourcePlugin({
  site: Site.SUPERLINEAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SuperlinearService implements IScraper {
  private readonly logger = new Logger(SuperlinearService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Superlinear',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Superlinear: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SUPERLINEAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'superlinear-');
      }
    }

    this.logger.log(`Superlinear: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
