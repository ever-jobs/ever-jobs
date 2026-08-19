import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Buck Mason — American menswear and womenswear brand selling online and through retail stores.
 *
 * Buck Mason is an American clothing brand designing menswear and womenswear
 * collections. It sells through its e-commerce site and brick-and-mortar
 * stores across US cities including Los Angeles, San Francisco, and New
 * York.
 *
 * Sector: Retail / Apparel e-commerce. HQ: Los Angeles, California, USA.
 *
 * Source: Lever job board, company slug `buckmason`
 * (`https://jobs.lever.co/buckmason`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'buckmason';
const COMPANY_NAME = 'Buck Mason';

@SourcePlugin({
  site: Site.BUCK_MASON,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BuckMasonService implements IScraper {
  private readonly logger = new Logger(BuckMasonService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Buck Mason',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Buck Mason: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BUCK_MASON;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'buckmason-');
      }
    }

    this.logger.log(`Buck Mason: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
