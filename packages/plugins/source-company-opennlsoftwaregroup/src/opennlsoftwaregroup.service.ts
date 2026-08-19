import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * OPEN.nl Software Group — Software group building enterprise content management (ECM) and related business software.
 *
 * OPEN.nl Software Group is an Amersfoort-based software group building
 * enterprise content management and related business software, hiring
 * developers, consultants, product managers, and support staff in the
 * Netherlands.
 *
 * Sector: Enterprise software / ECM. HQ: Amersfoort, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `opennl`
 * (`https://opennl.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'opennl';
const COMPANY_NAME = 'OPEN.nl Software Group';

@SourcePlugin({
  site: Site.OPEN_NL_SOFTWARE_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OPENNlSoftwareGroupService implements IScraper {
  private readonly logger = new Logger(OPENNlSoftwareGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape OPEN.nl Software Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `OPEN.nl Software Group: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OPEN_NL_SOFTWARE_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'opennlsoftwaregroup-');
      }
    }

    this.logger.log(`OPEN.nl Software Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
