import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Educative — Interactive online learning platform for software developers.
 *
 * Educative is an online learning platform offering interactive, text-based
 * courses for software developers and technical professionals. It has
 * engineering and content teams including in Lahore.
 *
 * Sector: education. HQ: Seattle, Washington, United States.
 *
 * Source: Lever job board, company slug `educative`
 * (`https://jobs.lever.co/educative`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'educative';
const COMPANY_NAME = 'Educative';

@SourcePlugin({
  site: Site.EDUCATIVE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EducativeService implements IScraper {
  private readonly logger = new Logger(EducativeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Educative',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Educative: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EDUCATIVE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'educative-');
      }
    }

    this.logger.log(`Educative: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
