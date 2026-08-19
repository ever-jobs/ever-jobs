import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Larian Studios — Independent video game developer known for the Divinity and Baldur\'s Gate role-playing game series.
 *
 * Larian Studios is a video game developer that produces role-playing games
 * including the Divinity series and Baldur's Gate 3. It operates studios
 * across several countries.
 *
 * Sector: gaming. HQ: Ghent, East Flanders, Belgium.
 *
 * Source: Lever job board, company slug `larian`
 * (`https://jobs.lever.co/larian`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'larian';
const COMPANY_NAME = 'Larian Studios';

@SourcePlugin({
  site: Site.LARIAN_STUDIOS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LarianStudiosService implements IScraper {
  private readonly logger = new Logger(LarianStudiosService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Larian Studios',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Larian Studios: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LARIAN_STUDIOS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'larian-');
      }
    }

    this.logger.log(`Larian Studios: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
