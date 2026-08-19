import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * VIKTOR — Low-code application development platform for engineers to build and deploy web apps.
 *
 * VIKTOR is a Rotterdam-based SaaS company offering a Python-based low-code
 * platform that lets engineers build, deploy, and share web applications and
 * automate engineering workflows without front-end development.
 *
 * Sector: Engineering / low-code SaaS. HQ: Rotterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `viktor`
 * (`https://viktor.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'viktor';
const COMPANY_NAME = 'VIKTOR';

@SourcePlugin({
  site: Site.VIKTOR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VIKTORService implements IScraper {
  private readonly logger = new Logger(VIKTORService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape VIKTOR',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `VIKTOR: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VIKTOR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'viktor-');
      }
    }

    this.logger.log(`VIKTOR: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
