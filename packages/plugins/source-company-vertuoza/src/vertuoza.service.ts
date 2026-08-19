import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Vertuoza — Construction-management software for small and mid-size building firms.
 *
 * Vertuoza is a Walloon software company building management software for
 * construction SMEs. Its Recruitee board at vertuoza.recruitee.com listed 5
 * offers including Lead Platform Engineer and several sales roles, all based
 * in Nivelles, Belgium.
 *
 * Sector: Software / Construction SaaS. HQ: Nivelles, Belgium.
 *
 * Source: Recruitee careers board, subdomain `vertuoza`
 * (`https://vertuoza.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'vertuoza';
const COMPANY_NAME = 'Vertuoza';

@SourcePlugin({
  site: Site.VERTUOZA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VertuozaService implements IScraper {
  private readonly logger = new Logger(VertuozaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Vertuoza',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Vertuoza: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VERTUOZA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'vertuoza-');
      }
    }

    this.logger.log(`Vertuoza: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
