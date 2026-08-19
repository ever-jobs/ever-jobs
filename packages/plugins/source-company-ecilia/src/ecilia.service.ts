import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ecilia — SaaS software vendor for the insurance sector, developer of the Modulr platform.
 *
 * Ecilia is a French SaaS company that has developed 'Modulr', a platform
 * for insurance-sector clients, in operation since 2001. It is a
 * small-to-medium enterprise (around twenty employees) describing itself as
 * entering a new growth phase. Careers are hosted on Recruitee at
 * ecilia.recruitee.com.
 *
 * Sector: InsurTech / SaaS. HQ: France.
 *
 * Source: Recruitee careers board, subdomain `ecilia`
 * (`https://ecilia.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'ecilia';
const COMPANY_NAME = 'Ecilia';

@SourcePlugin({
  site: Site.ECILIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EciliaService implements IScraper {
  private readonly logger = new Logger(EciliaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Ecilia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ecilia: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ECILIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'ecilia-');
      }
    }

    this.logger.log(`Ecilia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
