import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * TOPIC — Embedded systems and software development company serving high-tech industries.
 *
 * TOPIC (TOPIC Embedded Systems / Software Development) is a Best,
 * Noord-Brabant company delivering embedded systems and software development
 * services and products for high-tech industries, hiring software and DevOps
 * engineers.
 *
 * Sector: Embedded systems / software. HQ: Best, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `topicsoftwaredevelopment`
 * (`https://topicsoftwaredevelopment.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'topicsoftwaredevelopment';
const COMPANY_NAME = 'TOPIC';

@SourcePlugin({
  site: Site.TOPIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TOPICService implements IScraper {
  private readonly logger = new Logger(TOPICService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape TOPIC',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `TOPIC: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TOPIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'topic-');
      }
    }

    this.logger.log(`TOPIC: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
