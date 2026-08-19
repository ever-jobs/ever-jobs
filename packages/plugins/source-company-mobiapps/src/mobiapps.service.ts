import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mobiapps — Digital services company specializing in mobile, web application development and QA/testing.
 *
 * Mobiapps is a French digital-services company delivering consulting and
 * technical implementation for mobile and web application development,
 * quality assurance and testing across native, cross-platform and
 * progressive-web-app technologies. Careers are hosted on Recruitee at
 * mobiapps.recruitee.com.
 *
 * Sector: IT services / Software development. HQ: France.
 *
 * Source: Recruitee careers board, subdomain `mobiapps`
 * (`https://mobiapps.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'mobiapps';
const COMPANY_NAME = 'Mobiapps';

@SourcePlugin({
  site: Site.MOBIAPPS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MobiappsService implements IScraper {
  private readonly logger = new Logger(MobiappsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Mobiapps',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mobiapps: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MOBIAPPS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'mobiapps-');
      }
    }

    this.logger.log(`Mobiapps: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
