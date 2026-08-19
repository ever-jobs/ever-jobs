import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Observable Space — Builds telescopes, lasercom ground stations, and optical sensors for space domain awareness.
 *
 * Observable Space develops software-defined telescopes and vertically
 * integrated optical hardware and software for space observation. Its
 * product areas include laser communications ground stations, ground-based
 * optical space domain awareness sensing, and in-space optical payloads. The
 * company was formed from the merger of OurSky and PlaneWave Instruments and
 * has a US Space Force IDIQ contract.
 *
 * Sector: Space (Optics & Domain Awareness). HQ: Los Angeles, California, USA.
 *
 * Source: Ashby job board, company slug `observable-space`
 * (`https://jobs.ashbyhq.com/observable-space`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'observable-space';
const COMPANY_NAME = 'Observable Space';

@SourcePlugin({
  site: Site.OBSERVABLE_SPACE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ObservableSpaceService implements IScraper {
  private readonly logger = new Logger(ObservableSpaceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Observable Space',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Observable Space: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OBSERVABLE_SPACE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'observablespace-');
      }
    }

    this.logger.log(`Observable Space: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
