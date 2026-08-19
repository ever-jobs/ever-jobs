import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * OnePay — An all-in-one consumer financial services app spanning banking, savings, credit, and more.
 *
 * OnePay is a consumer financial services platform that brings together
 * banking, high-yield savings, credit cards, point-of-sale lending,
 * investing, and crypto in a single app. It partners with employers, HCM
 * providers, and gig platforms.
 *
 * Sector: Fintech - Consumer financial services. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `oneapp`
 * (`https://jobs.ashbyhq.com/oneapp`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'oneapp';
const COMPANY_NAME = 'OnePay';

@SourcePlugin({
  site: Site.ONEPAY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OnePayService implements IScraper {
  private readonly logger = new Logger(OnePayService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape OnePay',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `OnePay: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ONEPAY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'onepay-');
      }
    }

    this.logger.log(`OnePay: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
