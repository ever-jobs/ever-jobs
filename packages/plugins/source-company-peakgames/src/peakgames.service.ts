import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Peak — Mobile games company known for the titles Toon Blast and Toy Blast.
 *
 * Peak is a mobile gaming company that develops casual puzzle games
 * including Toon Blast and Toy Blast. It is based in Istanbul.
 *
 * Sector: gaming. HQ: Istanbul, Istanbul, Turkey.
 *
 * Source: Lever job board, company slug `peakgames`
 * (`https://jobs.lever.co/peakgames`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'peakgames';
const COMPANY_NAME = 'Peak';

@SourcePlugin({
  site: Site.PEAK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PeakService implements IScraper {
  private readonly logger = new Logger(PeakService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Peak',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Peak: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PEAK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'peakgames-');
      }
    }

    this.logger.log(`Peak: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
