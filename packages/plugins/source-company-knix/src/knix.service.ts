import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Knix — Intimate apparel brand selling online and through North American retail stores.
 *
 * Knix is an intimate apparel brand selling underwear, bras, and related
 * products direct-to-consumer online and through retail stores across
 * Canada. It focuses on leakproof and comfort-oriented intimates.
 *
 * Sector: Retail / Apparel e-commerce. HQ: Toronto, Ontario, Canada.
 *
 * Source: Lever job board, company slug `knix`
 * (`https://jobs.lever.co/knix`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'knix';
const COMPANY_NAME = 'Knix';

@SourcePlugin({
  site: Site.KNIX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KnixService implements IScraper {
  private readonly logger = new Logger(KnixService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Knix',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Knix: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KNIX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'knix-');
      }
    }

    this.logger.log(`Knix: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
