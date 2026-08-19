import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Dream Games — Mobile game developer behind the puzzle title Royal Match.
 *
 * Dream Games is a mobile gaming company that develops casual puzzle games,
 * most notably Royal Match. It is based in Istanbul.
 *
 * Sector: gaming. HQ: Istanbul, Istanbul, Turkey.
 *
 * Source: Lever job board, company slug `dreamgames`
 * (`https://jobs.lever.co/dreamgames`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'dreamgames';
const COMPANY_NAME = 'Dream Games';

@SourcePlugin({
  site: Site.DREAM_GAMES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DreamGamesService implements IScraper {
  private readonly logger = new Logger(DreamGamesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Dream Games',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Dream Games: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DREAM_GAMES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'dreamgames-');
      }
    }

    this.logger.log(`Dream Games: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
