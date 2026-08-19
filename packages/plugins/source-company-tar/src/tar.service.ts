import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * TAR — Builds behind-the-meter renewable power systems to supply off-grid electricity to data centers.
 *
 * TAR builds modular, behind-the-meter power systems combining solar,
 * battery storage, and backup generation to power data centers without
 * waiting for grid interconnection. The company manufactures, deploys, and
 * operates these islanded microgrids, initially in West Texas. It raised
 * funding to scale its off-grid power plant approach.
 *
 * Sector: Off-grid renewable power. HQ: Texas, USA.
 *
 * Source: Ashby job board, company slug `tar`
 * (`https://jobs.ashbyhq.com/tar`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tar';
const COMPANY_NAME = 'TAR';

@SourcePlugin({
  site: Site.TAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TARService implements IScraper {
  private readonly logger = new Logger(TARService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape TAR',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `TAR: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'tar-');
      }
    }

    this.logger.log(`TAR: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
