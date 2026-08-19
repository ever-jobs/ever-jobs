import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Spotify — Audio streaming company that also builds Backstage, an enterprise developer platform.
 *
 * Spotify operates a global audio streaming service and, through Backstage,
 * offers an internal developer portal platform used by engineering
 * organizations. This Lever board carries roles across advertising, finance,
 * analytics, and Backstage.
 *
 * Sector: B2B SaaS / Developer Platforms & Media. HQ: Stockholm, Stockholm, Sweden.
 *
 * Source: Lever job board, company slug `spotify`
 * (`https://jobs.lever.co/spotify`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'spotify';
const COMPANY_NAME = 'Spotify';

@SourcePlugin({
  site: Site.SPOTIFY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpotifyService implements IScraper {
  private readonly logger = new Logger(SpotifyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Spotify',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Spotify: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPOTIFY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'spotify-');
      }
    }

    this.logger.log(`Spotify: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
