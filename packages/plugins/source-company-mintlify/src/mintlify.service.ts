import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mintlify — Platform for building and hosting developer and API documentation.
 *
 * Mintlify provides a platform for creating, hosting, and maintaining
 * developer and API documentation. It is used by software companies to
 * publish product and API docs.
 *
 * Sector: Developer tools / Documentation. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `mintlify`
 * (`https://jobs.ashbyhq.com/mintlify`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'mintlify';
const COMPANY_NAME = 'Mintlify';

@SourcePlugin({
  site: Site.MINTLIFY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MintlifyService implements IScraper {
  private readonly logger = new Logger(MintlifyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Mintlify',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mintlify: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MINTLIFY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'mintlify-');
      }
    }

    this.logger.log(`Mintlify: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
