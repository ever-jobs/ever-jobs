import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * TigerData (Timescale) — Postgres-based time-series and analytics database company, formerly Timescale.
 *
 * TigerData, formerly known as Timescale, develops a Postgres-based database
 * for time-series and analytical workloads and offers Tiger Cloud as its
 * managed service. The company hires across engineering, sales, and
 * customer-facing roles with globally distributed remote positions including
 * the US, Spain, and India.
 *
 * Sector: Databases / Time-Series. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `tigerdata`
 * (`https://jobs.ashbyhq.com/tigerdata`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tigerdata';
const COMPANY_NAME = 'TigerData (Timescale)';

@SourcePlugin({
  site: Site.TIGERDATA_TIMESCALE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TigerDataTimescaleService implements IScraper {
  private readonly logger = new Logger(TigerDataTimescaleService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape TigerData (Timescale)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `TigerData (Timescale): delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TIGERDATA_TIMESCALE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'tigerdatatimescale-');
      }
    }

    this.logger.log(`TigerData (Timescale): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
