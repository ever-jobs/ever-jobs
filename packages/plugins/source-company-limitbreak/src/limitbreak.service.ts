import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Limit Break — Web3 gaming studio building free-to-play blockchain games and NFT technology.
 *
 * Limit Break is a Web3 gaming studio developing free-to-play mobile games
 * that incorporate blockchain and NFT technology, along with the
 * smart-contract systems that support them.
 *
 * Sector: Web3 Gaming. HQ: Tokyo, Tokyo, Japan.
 *
 * Source: Lever job board, company slug `limitbreak`
 * (`https://jobs.lever.co/limitbreak`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'limitbreak';
const COMPANY_NAME = 'Limit Break';

@SourcePlugin({
  site: Site.LIMIT_BREAK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LimitBreakService implements IScraper {
  private readonly logger = new Logger(LimitBreakService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Limit Break',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Limit Break: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LIMIT_BREAK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'limitbreak-');
      }
    }

    this.logger.log(`Limit Break: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
