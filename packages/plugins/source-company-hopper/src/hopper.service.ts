import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hopper — Mobile-first travel booking marketplace for flights, hotels, and travel fintech products.
 *
 * Hopper is a travel booking app and marketplace that lets users book
 * flights, hotels, and rental cars, and sells travel fintech products such
 * as price freeze and cancellation protection. It also powers travel
 * commerce for third parties through its HTS (Hopper Technology Solutions)
 * API. The company is headquartered in Montreal.
 *
 * Sector: Travel marketplace / e-commerce. HQ: Montreal, Quebec, Canada.
 *
 * Source: Ashby job board, company slug `hopper`
 * (`https://jobs.ashbyhq.com/hopper`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hopper';
const COMPANY_NAME = 'Hopper';

@SourcePlugin({
  site: Site.HOPPER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HopperService implements IScraper {
  private readonly logger = new Logger(HopperService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Hopper',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hopper: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HOPPER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'hopper-');
      }
    }

    this.logger.log(`Hopper: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
