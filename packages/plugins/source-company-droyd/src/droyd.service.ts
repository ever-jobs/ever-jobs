import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Droyd — Designs and manufactures autonomous robots that automate repetitive manual work.
 *
 * Droyd designs autonomous robotic systems that automate repetitive manual
 * work for enterprises, building the hardware, control stack, and data to
 * enable generalist robotics. The company manufactures hardware in-house and
 * operates as an in-person company in San Francisco, California.
 *
 * Sector: Robotics / Industrial automation. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `droyd`
 * (`https://jobs.ashbyhq.com/droyd`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'droyd';
const COMPANY_NAME = 'Droyd';

@SourcePlugin({
  site: Site.DROYD,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DroydService implements IScraper {
  private readonly logger = new Logger(DroydService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Droyd',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Droyd: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DROYD;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'droyd-');
      }
    }

    this.logger.log(`Droyd: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
