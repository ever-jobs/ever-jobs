import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Linear — Issue tracking and project management tool for software teams.
 *
 * Linear builds an issue tracking and software project management
 * application designed for engineering and product teams. The product
 * emphasizes speed and a keyboard-driven workflow.
 *
 * Sector: Developer tools / Project management. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `linear`
 * (`https://jobs.ashbyhq.com/linear`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'linear';
const COMPANY_NAME = 'Linear';

@SourcePlugin({
  site: Site.LINEAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LinearService implements IScraper {
  private readonly logger = new Logger(LinearService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Linear',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Linear: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LINEAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'linear-');
      }
    }

    this.logger.log(`Linear: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
