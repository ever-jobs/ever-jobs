import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ON2IT — Cybersecurity company providing Zero Trust security services and a managed security platform.
 *
 * ON2IT is a Zaltbommel-based cybersecurity company delivering Zero Trust
 * security services, managed detection and response (SOC), and a security
 * orchestration platform. It hires security consultants, SOC specialists,
 * and PHP/Go developers.
 *
 * Sector: Cybersecurity SaaS / services. HQ: Zaltbommel, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `on2it`
 * (`https://on2it.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'on2it';
const COMPANY_NAME = 'ON2IT';

@SourcePlugin({
  site: Site.ON2IT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ON2ITService implements IScraper {
  private readonly logger = new Logger(ON2ITService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape ON2IT',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `ON2IT: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ON2IT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'on2it-');
      }
    }

    this.logger.log(`ON2IT: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
