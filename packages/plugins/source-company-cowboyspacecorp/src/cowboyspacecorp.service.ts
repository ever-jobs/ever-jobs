import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cowboy Space Corp. — Develops satellites to collect solar energy in orbit and transmit it to Earth.
 *
 * Cowboy Space Corp. is building infrastructure for the orbital economy,
 * with satellites in low Earth orbit designed to collect sunlight and
 * transmit energy via infrared lasers. The company was founded in 2024 by
 * Baiju Bhatt. Its engineering spans avionics, propulsion, spacecraft, and
 * optical communications.
 *
 * Sector: Space. HQ: USA.
 *
 * Source: Ashby job board, company slug `cowboyspace`
 * (`https://jobs.ashbyhq.com/cowboyspace`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cowboyspace';
const COMPANY_NAME = 'Cowboy Space Corp.';

@SourcePlugin({
  site: Site.COWBOY_SPACE_CORP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CowboySpaceCorpService implements IScraper {
  private readonly logger = new Logger(CowboySpaceCorpService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Cowboy Space Corp.',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cowboy Space Corp.: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COWBOY_SPACE_CORP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'cowboyspacecorp-');
      }
    }

    this.logger.log(`Cowboy Space Corp.: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
