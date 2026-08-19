import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Global Lending Services — Auto finance company providing subprime and near-prime vehicle loans through dealerships.
 *
 * Global Lending Services (GLS) provides auto financing, specializing in
 * subprime and near-prime vehicle loans originated through a national
 * dealership network. It operates the glsauto.com platform.
 *
 * Sector: Auto Lending. HQ: Greenville, South Carolina, United States.
 *
 * Source: Lever job board, company slug `glsllc`
 * (`https://jobs.lever.co/glsllc`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'glsllc';
const COMPANY_NAME = 'Global Lending Services';

@SourcePlugin({
  site: Site.GLOBAL_LENDING_SERVICES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GlobalLendingServicesService implements IScraper {
  private readonly logger = new Logger(GlobalLendingServicesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Global Lending Services',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Global Lending Services: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GLOBAL_LENDING_SERVICES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'glsllc-');
      }
    }

    this.logger.log(`Global Lending Services: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
