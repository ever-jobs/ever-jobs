import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Allium — Blockchain data platform building a system of record for onchain finance.
 *
 * Allium is a blockchain data platform that structures onchain data for
 * analytics and financial use cases. It positions itself as a system of
 * record for onchain finance. The company has team members across New York,
 * San Francisco, Singapore, and remote.
 *
 * Sector: Onchain data infrastructure. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `allium`
 * (`https://jobs.ashbyhq.com/allium`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'allium';
const COMPANY_NAME = 'Allium';

@SourcePlugin({
  site: Site.ALLIUM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AlliumService implements IScraper {
  private readonly logger = new Logger(AlliumService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Allium',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Allium: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ALLIUM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'allium-');
      }
    }

    this.logger.log(`Allium: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
