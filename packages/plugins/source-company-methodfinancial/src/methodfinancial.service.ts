import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Method Financial — An API platform for connecting to consumer liability accounts and executing payments.
 *
 * Method Financial provides APIs to connect to consumer financial accounts,
 * offering real-time liability connectivity and instant payment execution.
 * The platform is used to retrieve and act on consumer debt and liability
 * data.
 *
 * Sector: Fintech - Financial data connectivity. HQ: Austin, Texas, USA.
 *
 * Source: Ashby job board, company slug `method`
 * (`https://jobs.ashbyhq.com/method`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'method';
const COMPANY_NAME = 'Method Financial';

@SourcePlugin({
  site: Site.METHOD_FINANCIAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MethodFinancialService implements IScraper {
  private readonly logger = new Logger(MethodFinancialService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Method Financial',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Method Financial: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.METHOD_FINANCIAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'methodfinancial-');
      }
    }

    this.logger.log(`Method Financial: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
