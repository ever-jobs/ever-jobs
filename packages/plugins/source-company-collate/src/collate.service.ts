import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Collate — Provides an AI document-generation platform for life-sciences regulatory work.
 *
 * Collate is an AI document-generation platform for life sciences that
 * automates regulatory and development paperwork across drug, diagnostic and
 * medical-device development.
 *
 * Sector: Applied AI / life sciences. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `collate`
 * (`https://jobs.lever.co/collate`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'collate';
const COMPANY_NAME = 'Collate';

@SourcePlugin({
  site: Site.COLLATE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CollateService implements IScraper {
  private readonly logger = new Logger(CollateService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Collate',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Collate: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COLLATE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'collate-');
      }
    }

    this.logger.log(`Collate: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
