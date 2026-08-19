import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * UP42 — Geospatial marketplace and platform for ordering and analyzing Earth-observation data.
 *
 * UP42 GmbH, founded in 2019 and headquartered in Berlin, runs a platform
 * that aggregates satellite imagery and geospatial datasets so organizations
 * can order, access, and analyze Earth-observation data. Since July 2025 it
 * has been part of Neo Space Group.
 *
 * Sector: Geospatial data platform / SaaS. HQ: Berlin, Germany.
 *
 * Source: Recruitee careers board, subdomain `up42gmbh`
 * (`https://up42gmbh.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'up42gmbh';
const COMPANY_NAME = 'UP42';

@SourcePlugin({
  site: Site.UP42,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UP42Service implements IScraper {
  private readonly logger = new Logger(UP42Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape UP42',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `UP42: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UP42;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'up42-');
      }
    }

    this.logger.log(`UP42: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
