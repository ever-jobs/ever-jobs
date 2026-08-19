import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Airbyte — Open-source data integration platform for building data pipelines.
 *
 * Airbyte builds an open-source data integration platform for moving data
 * between sources and destinations. It offers a large catalog of connectors
 * and both self-hosted and cloud options for data pipelines.
 *
 * Sector: Data infrastructure / Data integration. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `airbyte`
 * (`https://jobs.ashbyhq.com/airbyte`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'airbyte';
const COMPANY_NAME = 'Airbyte';

@SourcePlugin({
  site: Site.AIRBYTE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AirbyteService implements IScraper {
  private readonly logger = new Logger(AirbyteService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Airbyte',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Airbyte: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AIRBYTE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'airbyte-');
      }
    }

    this.logger.log(`Airbyte: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
