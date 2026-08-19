import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Munich Electrification — Develops battery management systems and power electronics for electric vehicles and energy storage.
 *
 * Munich Electrification develops battery management systems and power
 * electronics for automotive, commercial vehicle, and energy storage
 * applications. Its products support the electrification of transportation
 * and stationary storage. The company is headquartered in the Munich area of
 * Germany.
 *
 * Sector: Battery / power electronics. HQ: Munich, Germany.
 *
 * Source: Ashby job board, company slug `munich-electrification`
 * (`https://jobs.ashbyhq.com/munich-electrification`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'munich-electrification';
const COMPANY_NAME = 'Munich Electrification';

@SourcePlugin({
  site: Site.MUNICH_ELECTRIFICATION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MunichElectrificationService implements IScraper {
  private readonly logger = new Logger(MunichElectrificationService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Munich Electrification',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Munich Electrification: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MUNICH_ELECTRIFICATION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'munichelectrification-');
      }
    }

    this.logger.log(`Munich Electrification: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
