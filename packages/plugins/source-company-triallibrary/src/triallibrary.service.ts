import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Trial Library — Platform expanding access to and diversity in oncology clinical trials.
 *
 * Trial Library operates a research platform aimed at improving access to
 * precision medicine and increasing diversity in oncology clinical trials by
 * connecting patients and providers to relevant studies.
 *
 * Sector: Health Tech / Clinical Research. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `triallibrary`
 * (`https://jobs.lever.co/triallibrary`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'triallibrary';
const COMPANY_NAME = 'Trial Library';

@SourcePlugin({
  site: Site.TRIAL_LIBRARY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TrialLibraryService implements IScraper {
  private readonly logger = new Logger(TrialLibraryService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Trial Library',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Trial Library: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRIAL_LIBRARY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'triallibrary-');
      }
    }

    this.logger.log(`Trial Library: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
