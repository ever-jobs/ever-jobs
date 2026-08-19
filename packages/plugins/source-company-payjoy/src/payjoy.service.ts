import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * PayJoy — Point-of-sale financing and credit provider for under-served customers in emerging markets.
 *
 * PayJoy provides point-of-sale financing and card products to under-served
 * consumers in emerging markets, using patented secured-credit technology
 * alongside machine learning and anti-fraud systems.
 *
 * Sector: Consumer Lending / Fintech. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `payjoy`
 * (`https://jobs.lever.co/payjoy`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'payjoy';
const COMPANY_NAME = 'PayJoy';

@SourcePlugin({
  site: Site.PAYJOY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PayJoyService implements IScraper {
  private readonly logger = new Logger(PayJoyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape PayJoy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `PayJoy: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PAYJOY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'payjoy-');
      }
    }

    this.logger.log(`PayJoy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
