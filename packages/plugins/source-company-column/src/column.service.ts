import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Column — A nationally chartered bank built for developers and builders.
 *
 * Column is a bank and software company that provides technology-forward
 * banking infrastructure for developers and builders, covering banking
 * products, payments, and credit. It offers direct access to banking rails
 * for fintech companies.
 *
 * Sector: Fintech - Banking infrastructure. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `column`
 * (`https://jobs.ashbyhq.com/column`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'column';
const COMPANY_NAME = 'Column';

@SourcePlugin({
  site: Site.COLUMN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ColumnService implements IScraper {
  private readonly logger = new Logger(ColumnService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Column',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Column: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COLUMN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'column-');
      }
    }

    this.logger.log(`Column: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
