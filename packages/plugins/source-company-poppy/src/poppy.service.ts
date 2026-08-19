import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Poppy — Belgian shared-mobility (car-sharing) operator with in-house tech team.
 *
 * Poppy is a Belgian shared-mobility (car-sharing) company operating in
 * Brussels and Antwerp, with an in-house engineering team. Its Recruitee
 * board at poppy.recruitee.com listed 5 offers across HR, operations, and
 * automotive-technical roles in Antwerp and Vilvoorde.
 *
 * Sector: Technology / Shared mobility. HQ: Antwerp, Belgium.
 *
 * Source: Recruitee careers board, subdomain `poppy`
 * (`https://poppy.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'poppy';
const COMPANY_NAME = 'Poppy';

@SourcePlugin({
  site: Site.POPPY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PoppyService implements IScraper {
  private readonly logger = new Logger(PoppyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Poppy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Poppy: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.POPPY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'poppy-');
      }
    }

    this.logger.log(`Poppy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
