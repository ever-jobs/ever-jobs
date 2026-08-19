import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * AeroVect — Develops autonomous driving technology for airport ground support equipment.
 *
 * AeroVect builds autonomy technology for airport ground handling,
 * converting ground support equipment into autonomous vehicles for airlines
 * and ground service providers. The company develops the hardware
 * integration and autonomous driving platform for airside operations. It is
 * a venture-backed Series A company.
 *
 * Sector: Autonomy / Aviation ground handling. HQ: USA.
 *
 * Source: Ashby job board, company slug `aerovect`
 * (`https://jobs.ashbyhq.com/aerovect`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'aerovect';
const COMPANY_NAME = 'AeroVect';

@SourcePlugin({
  site: Site.AEROVECT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AeroVectService implements IScraper {
  private readonly logger = new Logger(AeroVectService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape AeroVect',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `AeroVect: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AEROVECT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'aerovect-');
      }
    }

    this.logger.log(`AeroVect: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
