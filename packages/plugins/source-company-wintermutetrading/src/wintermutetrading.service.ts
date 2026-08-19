import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Wintermute — Algorithmic crypto trading and market-making firm providing digital-asset liquidity.
 *
 * Wintermute is a crypto-native algorithmic trading firm founded in 2017
 * that provides liquidity and market making across centralized and
 * decentralized venues for digital assets.
 *
 * Sector: Crypto Trading / Market Making. HQ: London, England, United Kingdom.
 *
 * Source: Lever job board, company slug `wintermute-trading`
 * (`https://jobs.lever.co/wintermute-trading`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'wintermute-trading';
const COMPANY_NAME = 'Wintermute';

@SourcePlugin({
  site: Site.WINTERMUTE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WintermuteService implements IScraper {
  private readonly logger = new Logger(WintermuteService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Wintermute',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Wintermute: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WINTERMUTE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'wintermutetrading-');
      }
    }

    this.logger.log(`Wintermute: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
