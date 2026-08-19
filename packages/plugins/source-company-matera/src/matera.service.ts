import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Matera — SaaS platform for co-ownership and residential property management (self-managed syndic).
 *
 * Matera is a Paris-based SaaS company offering a platform for co-ownership
 * (copropriété) and residential property management, letting building owners
 * self-manage or use assisted syndic services. It operates in France and
 * Germany. Careers are hosted on Recruitee at matera.recruitee.com.
 *
 * Sector: PropTech / SaaS. HQ: Paris, France.
 *
 * Source: Recruitee careers board, subdomain `matera`
 * (`https://matera.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'matera';
const COMPANY_NAME = 'Matera';

@SourcePlugin({
  site: Site.MATERA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MateraService implements IScraper {
  private readonly logger = new Logger(MateraService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Matera',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Matera: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MATERA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'matera-');
      }
    }

    this.logger.log(`Matera: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
