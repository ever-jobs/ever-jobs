import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Intescia — Data-intelligence group turning business data into growth signals across multiple brands.
 *
 * Intescia Group is a French data-intelligence company operating multiple
 * brands (including DoubleTrade, Explore, Edisys, Corporama, Societeinfo,
 * and Scores & Décisions) that provide business data, analytics and
 * lead-intelligence services across sectors such as construction, real
 * estate and public procurement. Careers are hosted on Recruitee at
 * intescia.recruitee.com.
 *
 * Sector: Data intelligence / SaaS. HQ: France.
 *
 * Source: Recruitee careers board, subdomain `intescia`
 * (`https://intescia.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'intescia';
const COMPANY_NAME = 'Intescia';

@SourcePlugin({
  site: Site.INTESCIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IntesciaService implements IScraper {
  private readonly logger = new Logger(IntesciaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Intescia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Intescia: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INTESCIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'intescia-');
      }
    }

    this.logger.log(`Intescia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
