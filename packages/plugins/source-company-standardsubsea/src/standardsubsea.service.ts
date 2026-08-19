import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Standard Subsea — Builds offshore robotics including unmanned surface vessels and subsea vehicles.
 *
 * Standard Subsea is building offshore robotics, including unmanned surface
 * vessels and subsea vehicles, along with the software to operate them
 * autonomously. The company focuses on autonomy for offshore and subsea
 * operations.
 *
 * Sector: Robotics / Offshore autonomy. HQ: United States.
 *
 * Source: Ashby job board, company slug `standardsubsea`
 * (`https://jobs.ashbyhq.com/standardsubsea`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'standardsubsea';
const COMPANY_NAME = 'Standard Subsea';

@SourcePlugin({
  site: Site.STANDARD_SUBSEA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StandardSubseaService implements IScraper {
  private readonly logger = new Logger(StandardSubseaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Standard Subsea',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Standard Subsea: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STANDARD_SUBSEA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'standardsubsea-');
      }
    }

    this.logger.log(`Standard Subsea: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
