import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Spyke Games — Mobile gaming studio developing social casual games.
 *
 * Spyke Games is a mobile game studio based in Istanbul that develops social
 * casual games. It hires across game development, art and marketing.
 *
 * Sector: gaming. HQ: Istanbul, Istanbul, Turkey.
 *
 * Source: Lever job board, company slug `spyke-games`
 * (`https://jobs.lever.co/spyke-games`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'spyke-games';
const COMPANY_NAME = 'Spyke Games';

@SourcePlugin({
  site: Site.SPYKE_GAMES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpykeGamesService implements IScraper {
  private readonly logger = new Logger(SpykeGamesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Spyke Games',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Spyke Games: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPYKE_GAMES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'spykegames-');
      }
    }

    this.logger.log(`Spyke Games: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
