import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Radiant Industries — Develops portable microreactors to provide clean power for remote and off-grid sites.
 *
 * Radiant Industries is developing a portable nuclear microreactor designed
 * to be transported and deployed to provide power in remote locations and to
 * replace diesel generators. The reactor is intended to be factory-produced
 * and moved by truck, ship, or plane. The company is based in El Segundo,
 * California.
 *
 * Sector: Nuclear microreactors. HQ: El Segundo, California, USA.
 *
 * Source: Ashby job board, company slug `radiant-industries`
 * (`https://jobs.ashbyhq.com/radiant-industries`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'radiant-industries';
const COMPANY_NAME = 'Radiant Industries';

@SourcePlugin({
  site: Site.RADIANT_INDUSTRIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RadiantIndustriesService implements IScraper {
  private readonly logger = new Logger(RadiantIndustriesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Radiant Industries',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Radiant Industries: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RADIANT_INDUSTRIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'radiantindustries-');
      }
    }

    this.logger.log(`Radiant Industries: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
