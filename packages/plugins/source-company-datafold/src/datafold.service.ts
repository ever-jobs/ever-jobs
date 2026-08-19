import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Datafold — Data quality and migration automation platform for data engineering teams.
 *
 * Datafold builds a data quality and migration automation platform for data
 * engineering teams, including data diffing and testing tools. The company
 * operates remotely with forward-deployed data engineering and sales roles
 * in the US and EU.
 *
 * Sector: Data Infrastructure / Data Quality. HQ: Remote (US-registered).
 *
 * Source: Ashby job board, company slug `datafold`
 * (`https://jobs.ashbyhq.com/datafold`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'datafold';
const COMPANY_NAME = 'Datafold';

@SourcePlugin({
  site: Site.DATAFOLD,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DatafoldService implements IScraper {
  private readonly logger = new Logger(DatafoldService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Datafold',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Datafold: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DATAFOLD;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'datafold-');
      }
    }

    this.logger.log(`Datafold: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
