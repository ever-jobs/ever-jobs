import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Base Power Company — Deploys a network of distributed home batteries to strengthen the electric grid and provide backup power.
 *
 * Base Power is an energy company that installs distributed battery systems
 * in homes and connects them into a network that supports the electric grid.
 * It manufactures its own battery hardware and pairs it with a retail
 * electricity offering. The company operates in Texas and is expanding to
 * additional markets.
 *
 * Sector: Grid / energy storage. HQ: Austin, Texas, USA.
 *
 * Source: Ashby job board, company slug `base-power`
 * (`https://jobs.ashbyhq.com/base-power`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'base-power';
const COMPANY_NAME = 'Base Power Company';

@SourcePlugin({
  site: Site.BASE_POWER_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BasePowerCompanyService implements IScraper {
  private readonly logger = new Logger(BasePowerCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Base Power Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Base Power Company: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BASE_POWER_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'basepowercompany-');
      }
    }

    this.logger.log(`Base Power Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
