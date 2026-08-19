import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Matia — DataOps platform for ingestion, reverse ETL, observability, and data cataloging.
 *
 * Matia is a DataOps platform that provides data ingestion, reverse ETL,
 * data observability, and data cataloging in a single product. The company
 * hires across GTM and Engineering with roles in the US (remote) and Tel
 * Aviv, Israel.
 *
 * Sector: Data Infrastructure / DataOps. HQ: Remote (US) and Tel Aviv, Israel.
 *
 * Source: Ashby job board, company slug `matia`
 * (`https://jobs.ashbyhq.com/matia`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'matia';
const COMPANY_NAME = 'Matia';

@SourcePlugin({
  site: Site.MATIA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MatiaService implements IScraper {
  private readonly logger = new Logger(MatiaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Matia',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Matia: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MATIA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'matia-');
      }
    }

    this.logger.log(`Matia: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
