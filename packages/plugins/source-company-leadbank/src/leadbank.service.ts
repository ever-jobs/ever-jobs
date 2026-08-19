import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lead Bank — An FDIC-insured bank building infrastructure for embedded financial products.
 *
 * Lead is a bank and technology company that builds banking infrastructure
 * for embedded financial products and services, operating an FDIC-insured
 * bank. It serves fintech partners with banking and payments rails.
 *
 * Sector: Fintech - Banking infrastructure. HQ: Kansas City, Missouri, USA.
 *
 * Source: Ashby job board, company slug `leadbank`
 * (`https://jobs.ashbyhq.com/leadbank`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'leadbank';
const COMPANY_NAME = 'Lead Bank';

@SourcePlugin({
  site: Site.LEAD_BANK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LeadBankService implements IScraper {
  private readonly logger = new Logger(LeadBankService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Lead Bank',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lead Bank: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LEAD_BANK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'leadbank-');
      }
    }

    this.logger.log(`Lead Bank: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
