import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Charge Robotics — Builds robotic systems that automate the construction of utility-scale solar farms.
 *
 * Charge Robotics is a Series A startup building robots that automate the
 * mechanical installation of utility-scale solar farms. The company develops
 * hardware to speed up field assembly of solar arrays. It is headquartered
 * in San Leandro, California, with field operations in Phoenix, Arizona.
 *
 * Sector: Robotics / Renewable energy automation. HQ: San Leandro, California, USA.
 *
 * Source: Ashby job board, company slug `charge-robotics`
 * (`https://jobs.ashbyhq.com/charge-robotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'charge-robotics';
const COMPANY_NAME = 'Charge Robotics';

@SourcePlugin({
  site: Site.CHARGE_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ChargeRoboticsService implements IScraper {
  private readonly logger = new Logger(ChargeRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Charge Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Charge Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CHARGE_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'chargerobotics-');
      }
    }

    this.logger.log(`Charge Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
