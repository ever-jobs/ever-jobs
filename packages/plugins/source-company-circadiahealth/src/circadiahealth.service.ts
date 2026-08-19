import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Circadia Health — Medical device and data company for contactless remote patient monitoring.
 *
 * Circadia Health develops a contactless remote patient monitoring system
 * combining hardware, software, and algorithms to continuously track vital
 * signs and detect medical events, with an FDA-cleared monitoring product.
 *
 * Sector: Health Tech / Medical Device. HQ: Los Angeles, California, USA.
 *
 * Source: Lever job board, company slug `circadiahealth`
 * (`https://jobs.lever.co/circadiahealth`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'circadiahealth';
const COMPANY_NAME = 'Circadia Health';

@SourcePlugin({
  site: Site.CIRCADIA_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CircadiaHealthService implements IScraper {
  private readonly logger = new Logger(CircadiaHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Circadia Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Circadia Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CIRCADIA_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'circadiahealth-');
      }
    }

    this.logger.log(`Circadia Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
