import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * RepRally — Platform connecting independent sales representatives with brands to sell into local retail stores.
 *
 * RepRally operates a platform that connects independent territory sales
 * representatives with consumer brands to place products into local and
 * independent retail stores. It supports the retail distribution and
 * merchandising process through its app. The company hosts its careers page
 * on Ashby.
 *
 * Sector: Retail tech / B2B sales marketplace. HQ: New York, New York, United States.
 *
 * Source: Ashby job board, company slug `reprally`
 * (`https://jobs.ashbyhq.com/reprally`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'reprally';
const COMPANY_NAME = 'RepRally';

@SourcePlugin({
  site: Site.REPRALLY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RepRallyService implements IScraper {
  private readonly logger = new Logger(RepRallyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape RepRally',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `RepRally: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REPRALLY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'reprally-');
      }
    }

    this.logger.log(`RepRally: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
