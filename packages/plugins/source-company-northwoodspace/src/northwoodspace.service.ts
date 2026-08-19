import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Northwood Space — Builds software-defined phased-array antennas for satellite ground stations.
 *
 * Northwood Space produces phased-array antenna hardware and integrated
 * software to enable communication with satellites across multiple orbits.
 * Its Portal system is designed for mass manufacturing and aims to simplify
 * ground station deployment. The company was founded in 2022 and operates a
 * facility in Torrance, California.
 *
 * Sector: Space (Ground Infrastructure). HQ: Torrance, California, USA.
 *
 * Source: Ashby job board, company slug `northwoodspace`
 * (`https://jobs.ashbyhq.com/northwoodspace`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'northwoodspace';
const COMPANY_NAME = 'Northwood Space';

@SourcePlugin({
  site: Site.NORTHWOOD_SPACE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NorthwoodSpaceService implements IScraper {
  private readonly logger = new Logger(NorthwoodSpaceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Northwood Space',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Northwood Space: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NORTHWOOD_SPACE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'northwoodspace-');
      }
    }

    this.logger.log(`Northwood Space: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
