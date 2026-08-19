import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Arc\'teryx — Outdoor apparel and equipment brand selling gear online and in retail stores.
 *
 * Arc'teryx is an outdoor apparel and equipment brand headquartered in North
 * Vancouver. It designs and sells technical outdoor gear through its own
 * retail stores, outlets, and e-commerce channels.
 *
 * Sector: Retail / Outdoor e-commerce. HQ: North Vancouver, British Columbia, Canada.
 *
 * Source: Lever job board, company slug `arcteryx.com`
 * (`https://jobs.lever.co/arcteryx.com`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'arcteryx.com';
const COMPANY_NAME = 'Arc\'teryx';

@SourcePlugin({
  site: Site.ARC_TERYX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ArcTeryxService implements IScraper {
  private readonly logger = new Logger(ArcTeryxService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Arc\'teryx',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Arc\'teryx: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARC_TERYX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'arcteryxcom-');
      }
    }

    this.logger.log(`Arc\'teryx: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
