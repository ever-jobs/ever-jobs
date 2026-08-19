import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sun Studio — Mobile game studio developing casual and puzzle games.
 *
 * Sun Studio is a mobile game studio based in Ho Chi Minh City that develops
 * casual and puzzle games. It hires across art, design and Unity game
 * development.
 *
 * Sector: gaming. HQ: Ho Chi Minh City, Vietnam.
 *
 * Source: Lever job board, company slug `sunstudio`
 * (`https://jobs.lever.co/sunstudio`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sunstudio';
const COMPANY_NAME = 'Sun Studio';

@SourcePlugin({
  site: Site.SUN_STUDIO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SunStudioService implements IScraper {
  private readonly logger = new Logger(SunStudioService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Sun Studio',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sun Studio: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SUN_STUDIO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'sunstudio-');
      }
    }

    this.logger.log(`Sun Studio: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
