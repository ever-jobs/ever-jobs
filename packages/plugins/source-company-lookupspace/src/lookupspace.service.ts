import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Look Up Space — Space-tech company operating a global radar network for space surveillance and debris management.
 *
 * SAS Look Up Space is a French space-technology company specializing in
 * space surveillance and space-debris management, developing and operating a
 * network of sovereign radars for space traffic management. Careers are
 * hosted on Recruitee at lookup.recruitee.com.
 *
 * Sector: SpaceTech / Deep tech. HQ: France.
 *
 * Source: Recruitee careers board, subdomain `lookup`
 * (`https://lookup.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'lookup';
const COMPANY_NAME = 'Look Up Space';

@SourcePlugin({
  site: Site.LOOK_UP_SPACE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LookUpSpaceService implements IScraper {
  private readonly logger = new Logger(LookUpSpaceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Look Up Space',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Look Up Space: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LOOK_UP_SPACE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'lookupspace-');
      }
    }

    this.logger.log(`Look Up Space: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
