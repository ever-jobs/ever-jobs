import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Simvia — Compliance and certification management software for food and agriculture supply chains (formerly AgriPlace).
 *
 * Simvia (formerly AgriPlace) is an Amsterdam-based software company whose
 * platform manages compliance, certifications, and documentation across food
 * and agriculture supply chains. The agriplace.recruitee.com board now
 * redirects to simvia.recruitee.com.
 *
 * Sector: Compliance / agri-food SaaS. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `simvia`
 * (`https://simvia.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'simvia';
const COMPANY_NAME = 'Simvia';

@SourcePlugin({
  site: Site.SIMVIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SimviaService implements IScraper {
  private readonly logger = new Logger(SimviaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Simvia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Simvia: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SIMVIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'simvia-');
      }
    }

    this.logger.log(`Simvia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
