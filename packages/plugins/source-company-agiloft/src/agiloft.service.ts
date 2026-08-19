import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Agiloft — Data-first, AI-enabled contract lifecycle management (CLM) platform.
 *
 * Agiloft provides a configurable, API-first contract lifecycle management
 * platform with a no-code engine and AI capabilities for managing contracts
 * across their lifecycle. It hires platform engineering and go-to-market
 * roles, largely US remote.
 *
 * Sector: SaaS / no-code platform. HQ: Redwood City, California, United States.
 *
 * Source: Lever job board, company slug `agiloft`
 * (`https://jobs.lever.co/agiloft`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'agiloft';
const COMPANY_NAME = 'Agiloft';

@SourcePlugin({
  site: Site.AGILOFT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AgiloftService implements IScraper {
  private readonly logger = new Logger(AgiloftService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Agiloft',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Agiloft: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AGILOFT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'agiloft-');
      }
    }

    this.logger.log(`Agiloft: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
