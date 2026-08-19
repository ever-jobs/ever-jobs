import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Vertical Aerospace — Develops the VX4 electric vertical takeoff and landing (eVTOL) aircraft.
 *
 * Vertical Aerospace is a UK aerospace company developing the VX4, a piloted
 * electric vertical takeoff and landing aircraft. The company works across
 * advanced software, systems safety, and digital manufacturing engineering.
 * It is pursuing certification of its aircraft for advanced air mobility.
 *
 * Sector: Aerospace (eVTOL). HQ: Bristol, United Kingdom.
 *
 * Source: Ashby job board, company slug `vertical-aerospace`
 * (`https://jobs.ashbyhq.com/vertical-aerospace`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'vertical-aerospace';
const COMPANY_NAME = 'Vertical Aerospace';

@SourcePlugin({
  site: Site.VERTICAL_AEROSPACE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VerticalAerospaceService implements IScraper {
  private readonly logger = new Logger(VerticalAerospaceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Vertical Aerospace',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Vertical Aerospace: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VERTICAL_AEROSPACE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'verticalaerospace-');
      }
    }

    this.logger.log(`Vertical Aerospace: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
