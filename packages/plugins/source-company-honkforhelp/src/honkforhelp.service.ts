import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HONK — Roadside assistance and vehicle transport technology platform.
 *
 * HONK operates a technology platform connecting drivers, insurers and
 * service providers for roadside assistance and vehicle transport,
 * coordinating towing and logistics services.
 *
 * Sector: logistics. HQ: Los Angeles, California, United States.
 *
 * Source: Lever job board, company slug `honkforhelp`
 * (`https://jobs.lever.co/honkforhelp`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'honkforhelp';
const COMPANY_NAME = 'HONK';

@SourcePlugin({
  site: Site.HONK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HONKService implements IScraper {
  private readonly logger = new Logger(HONKService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape HONK',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `HONK: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HONK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'honkforhelp-');
      }
    }

    this.logger.log(`HONK: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
