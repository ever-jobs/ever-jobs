import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Swap — Commerce operations platform centralizing cross-border, tax, returns, and fulfillment for e-commerce brands.
 *
 * Swap is a commerce infrastructure platform that centralizes global
 * e-commerce operations for brands, including cross-border logistics, tax,
 * returns, and demand planning. It aims to unify back-office commerce
 * workflows into a single platform. The company hosts its careers page on
 * Ashby.
 *
 * Sector: E-commerce operations infrastructure. HQ: London, England, United Kingdom.
 *
 * Source: Ashby job board, company slug `swap`
 * (`https://jobs.ashbyhq.com/swap`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'swap';
const COMPANY_NAME = 'Swap';

@SourcePlugin({
  site: Site.SWAP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SwapService implements IScraper {
  private readonly logger = new Logger(SwapService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Swap',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Swap: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SWAP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'swap-');
      }
    }

    this.logger.log(`Swap: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
