import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Unit — An embedded finance platform providing banking and capital as a service.
 *
 * Unit is an embedded finance platform offering ready-to-launch financial
 * services such as banking accounts and capital, enabling companies to build
 * financial products for their end users. It has raised over $160M from
 * investors including Insight Partners and Accel.
 *
 * Sector: Fintech - Embedded finance / BaaS. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `unit`
 * (`https://jobs.ashbyhq.com/unit`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'unit';
const COMPANY_NAME = 'Unit';

@SourcePlugin({
  site: Site.UNIT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UnitService implements IScraper {
  private readonly logger = new Logger(UnitService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Unit',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Unit: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UNIT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'unit-');
      }
    }

    this.logger.log(`Unit: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
