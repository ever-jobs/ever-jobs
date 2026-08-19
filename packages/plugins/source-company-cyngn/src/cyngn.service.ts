import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cyngn — Autonomous vehicle technology for industrial and material-handling applications.
 *
 * Cyngn develops and deploys autonomous driving technology for industrial
 * vehicles such as forklifts and tuggers used in warehouses and
 * manufacturing. It is a publicly traded company.
 *
 * Sector: Autonomous Vehicles. HQ: Menlo Park, California, United States.
 *
 * Source: Lever job board, company slug `cyngn`
 * (`https://jobs.lever.co/cyngn`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'cyngn';
const COMPANY_NAME = 'Cyngn';

@SourcePlugin({
  site: Site.CYNGN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CyngnService implements IScraper {
  private readonly logger = new Logger(CyngnService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Cyngn',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cyngn: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CYNGN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'cyngn-');
      }
    }

    this.logger.log(`Cyngn: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
