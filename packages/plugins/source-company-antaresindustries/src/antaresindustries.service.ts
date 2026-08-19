import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Antares Industries — Develops transportable nuclear microreactors for defense, space, and terrestrial power.
 *
 * Antares Industries develops compact, transportable nuclear fission
 * microreactors for strategic energy applications on land, at sea, and in
 * space. Its R1 microreactor uses TRISO fuel and targets outputs between 100
 * kilowatts and 1 megawatt. The company has worked with the US Air Force, US
 * Space Force, NASA, and the Defense Innovation Unit.
 *
 * Sector: Nuclear (Defense & Space Power). HQ: USA.
 *
 * Source: Ashby job board, company slug `8fleet-inc`
 * (`https://jobs.ashbyhq.com/8fleet-inc`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = '8fleet-inc';
const COMPANY_NAME = 'Antares Industries';

@SourcePlugin({
  site: Site.ANTARES_INDUSTRIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AntaresIndustriesService implements IScraper {
  private readonly logger = new Logger(AntaresIndustriesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Antares Industries',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Antares Industries: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ANTARES_INDUSTRIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'antaresindustries-');
      }
    }

    this.logger.log(`Antares Industries: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
