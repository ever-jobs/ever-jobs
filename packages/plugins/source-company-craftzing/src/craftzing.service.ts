import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Craftzing — Digital product and transformation agency (engineering, design, strategy).
 *
 * Craftzing is a Belgian digital product and transformation agency operating
 * from Antwerp, Ghent, and Leuven. Its Recruitee board at
 * craftzing.recruitee.com listed 10 offers including solution architects, a
 * front-end Vue developer, and program/project managers.
 *
 * Sector: Software / Digital agency. HQ: Antwerp / Ghent, Belgium.
 *
 * Source: Recruitee careers board, subdomain `craftzing`
 * (`https://craftzing.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'craftzing';
const COMPANY_NAME = 'Craftzing';

@SourcePlugin({
  site: Site.CRAFTZING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CraftzingService implements IScraper {
  private readonly logger = new Logger(CraftzingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Craftzing',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Craftzing: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CRAFTZING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'craftzing-');
      }
    }

    this.logger.log(`Craftzing: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
