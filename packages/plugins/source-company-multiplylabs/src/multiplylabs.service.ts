import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Multiply Labs — Robotic systems for automated manufacturing of advanced biologic drugs.
 *
 * Multiply Labs builds robotic automation for the manufacturing of advanced
 * biologics such as cell and gene therapies, aiming to scale production of
 * individualized medicines.
 *
 * Sector: Robotics. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `multiplylabs`
 * (`https://jobs.lever.co/multiplylabs`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'multiplylabs';
const COMPANY_NAME = 'Multiply Labs';

@SourcePlugin({
  site: Site.MULTIPLY_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MultiplyLabsService implements IScraper {
  private readonly logger = new Logger(MultiplyLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Multiply Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Multiply Labs: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MULTIPLY_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'multiplylabs-');
      }
    }

    this.logger.log(`Multiply Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
