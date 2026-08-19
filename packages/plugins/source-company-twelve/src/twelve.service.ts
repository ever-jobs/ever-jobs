import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Twelve — Uses carbon transformation technology to turn CO2 into fuels, chemicals, and materials.
 *
 * Twelve develops carbon transformation technology that converts captured
 * carbon dioxide into chemicals, materials, and fuels using
 * electrochemistry. One focus area is producing sustainable aviation fuel
 * from CO2. The company is based in the San Francisco Bay Area.
 *
 * Sector: Carbon transformation. HQ: Berkeley, California, USA.
 *
 * Source: Ashby job board, company slug `twelve`
 * (`https://jobs.ashbyhq.com/twelve`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'twelve';
const COMPANY_NAME = 'Twelve';

@SourcePlugin({
  site: Site.TWELVE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TwelveService implements IScraper {
  private readonly logger = new Logger(TwelveService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Twelve',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Twelve: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TWELVE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'twelve-');
      }
    }

    this.logger.log(`Twelve: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
