import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Oscilar — Real-time risk decisioning platform built on scalable data pipelines.
 *
 * Oscilar builds a risk decisioning and analytics platform that ingests and
 * processes data across systems such as ClickHouse, Postgres, and Athena to
 * support real-time risk management and fraud/AML use cases. The company
 * hires across Engineering, Product, Sales, and Partnerships with remote
 * roles in the US and Canada.
 *
 * Sector: Data Infrastructure / Risk Analytics. HQ: Remote (US and Canada).
 *
 * Source: Ashby job board, company slug `oscilar`
 * (`https://jobs.ashbyhq.com/oscilar`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'oscilar';
const COMPANY_NAME = 'Oscilar';

@SourcePlugin({
  site: Site.OSCILAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OscilarService implements IScraper {
  private readonly logger = new Logger(OscilarService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Oscilar',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Oscilar: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OSCILAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'oscilar-');
      }
    }

    this.logger.log(`Oscilar: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
