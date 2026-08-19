import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Neo Financial — A Canadian financial technology company offering banking, credit, and savings products.
 *
 * Neo Financial is a Canadian fintech that offers digital banking, credit
 * cards, savings, and rewards products. It provides consumer financial
 * services through a mobile-first platform.
 *
 * Sector: Fintech - Neobanking. HQ: Calgary, Alberta, Canada.
 *
 * Source: Ashby job board, company slug `neofinancial`
 * (`https://jobs.ashbyhq.com/neofinancial`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'neofinancial';
const COMPANY_NAME = 'Neo Financial';

@SourcePlugin({
  site: Site.NEO_FINANCIAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NeoFinancialService implements IScraper {
  private readonly logger = new Logger(NeoFinancialService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Neo Financial',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Neo Financial: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NEO_FINANCIAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'neofinancial-');
      }
    }

    this.logger.log(`Neo Financial: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
