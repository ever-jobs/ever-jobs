import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Teleo — Converts heavy construction equipment into supervised autonomous machines.
 *
 * Teleo retrofits construction and heavy equipment such as loaders, dozers,
 * and excavators with a supervised autonomy kit, allowing a single operator
 * to remotely oversee multiple machines. It combines teleoperation with
 * autonomy software.
 *
 * Sector: Robotics. HQ: Palo Alto, California, United States.
 *
 * Source: Lever job board, company slug `teleo`
 * (`https://jobs.lever.co/teleo`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'teleo';
const COMPANY_NAME = 'Teleo';

@SourcePlugin({
  site: Site.TELEO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TeleoService implements IScraper {
  private readonly logger = new Logger(TeleoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Teleo',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Teleo: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TELEO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'teleo-');
      }
    }

    this.logger.log(`Teleo: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
