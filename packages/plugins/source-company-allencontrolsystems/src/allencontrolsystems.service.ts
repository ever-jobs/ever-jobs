import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Allen Control Systems — Defense robotics company building AI-powered autonomous
 * counter-drone weapon systems.
 *
 * Allen Control Systems (ACS) is an Austin, Texas-based defense
 * robotics company that develops autonomous counter-drone weapon
 * systems for U.S. and allied forces. Its flagship Bullfrog product
 * line uses AI, computer vision, and robotic fire control to detect,
 * track, and engage small unmanned aircraft. The company was founded
 * by Mike Wior, Steve Simoni, and Luke Allen, and manufactures its
 * systems in Austin. Hiring spans Engineering, Manufacturing, Supply
 * Chain, Quality, and Business Operations, including roles such as
 * Advanced Drone Operator and Buyer.
 *
 * Sector: Defense Technology / Robotics. HQ: Austin, TX, USA.
 *
 * Source: Ashby job board, company slug `allen-control-systems`
 * (`https://jobs.ashbyhq.com/allen-control-systems`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 *
 * (Previously read the Greenhouse board `allencontrolsystems`, which is stale —
 * the live, canonical board is Ashby. See find-company-plugin reconciliation.)
 */
const COMPANY_SLUG = 'allen-control-systems';
const COMPANY_NAME = 'Allen Control Systems';

@SourcePlugin({
  site: Site.ALLENCONTROLSYSTEMS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AllencontrolsystemsService implements IScraper {
  private readonly logger = new Logger(AllencontrolsystemsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Allen Control Systems',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Allen Control Systems: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ALLENCONTROLSYSTEMS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'allencontrolsystems-');
      }
    }

    this.logger.log(`Allen Control Systems: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
