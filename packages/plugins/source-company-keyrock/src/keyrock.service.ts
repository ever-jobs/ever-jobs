import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Keyrock — Digital asset market maker and trading firm for crypto markets.
 *
 * Keyrock is a crypto investment firm focused on market making, asset
 * management, and trading for digital assets. It provides liquidity across
 * crypto markets and offers OTC and options trading. The firm operates
 * across multiple countries.
 *
 * Sector: Crypto market making / trading. HQ: Brussels, Belgium.
 *
 * Source: Ashby job board, company slug `keyrock`
 * (`https://jobs.ashbyhq.com/keyrock`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'keyrock';
const COMPANY_NAME = 'Keyrock';

@SourcePlugin({
  site: Site.KEYROCK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KeyrockService implements IScraper {
  private readonly logger = new Logger(KeyrockService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Keyrock',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Keyrock: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KEYROCK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'keyrock-');
      }
    }

    this.logger.log(`Keyrock: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
