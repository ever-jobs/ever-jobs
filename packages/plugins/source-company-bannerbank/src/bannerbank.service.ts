import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Banner Bank — Regional commercial bank serving the Pacific Northwest and California.
 *
 * Banner Bank is a regional commercial bank offering personal and business
 * banking, lending, mortgage, and deposit services through branches across
 * the Pacific Northwest and Northern California.
 *
 * Sector: Banking. HQ: Walla Walla, Washington, United States.
 *
 * Source: Lever job board, company slug `bannerbank`
 * (`https://jobs.lever.co/bannerbank`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'bannerbank';
const COMPANY_NAME = 'Banner Bank';

@SourcePlugin({
  site: Site.BANNER_BANK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BannerBankService implements IScraper {
  private readonly logger = new Logger(BannerBankService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Banner Bank',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Banner Bank: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BANNER_BANK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'bannerbank-');
      }
    }

    this.logger.log(`Banner Bank: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
