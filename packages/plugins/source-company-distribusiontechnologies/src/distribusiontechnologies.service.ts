import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Distribusion Technologies — B2B technology marketplace connecting ground-transport operators with online retailers.
 *
 * Distribusion Technologies GmbH runs a B2B technology platform and
 * marketplace that connects bus, rail, and ferry operators in 70+ countries
 * with online retailers, providing search-to-ticket-purchase access to
 * ground transportation. It is headquartered in Berlin.
 *
 * Sector: Mobility / travel-tech platform. HQ: Berlin, Germany.
 *
 * Source: Recruitee careers board, subdomain `distribusion`
 * (`https://distribusion.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'distribusion';
const COMPANY_NAME = 'Distribusion Technologies';

@SourcePlugin({
  site: Site.DISTRIBUSION_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DistribusionTechnologiesService implements IScraper {
  private readonly logger = new Logger(DistribusionTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Distribusion Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Distribusion Technologies: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DISTRIBUSION_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'distribusiontechnologies-');
      }
    }

    this.logger.log(`Distribusion Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
