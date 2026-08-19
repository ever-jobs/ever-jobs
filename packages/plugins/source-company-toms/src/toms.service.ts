import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * TOMS — Footwear and accessories brand known for its giving-based business model.
 *
 * TOMS is a footwear, eyewear, and accessories brand that sells
 * direct-to-consumer, online through marketplaces, and via wholesale and
 * retail channels. The company is known for its history of tying charitable
 * giving to product sales. It is based in Los Angeles.
 *
 * Sector: Retail / consumer footwear brand. HQ: Los Angeles, California, United States.
 *
 * Source: Ashby job board, company slug `toms`
 * (`https://jobs.ashbyhq.com/toms`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'toms';
const COMPANY_NAME = 'TOMS';

@SourcePlugin({
  site: Site.TOMS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TOMSService implements IScraper {
  private readonly logger = new Logger(TOMSService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape TOMS',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `TOMS: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TOMS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'toms-');
      }
    }

    this.logger.log(`TOMS: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
