import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Contentsquare — Digital experience analytics platform that measures and analyzes user behavior on websites and apps.
 *
 * Contentsquare provides a digital experience analytics platform that
 * captures and analyzes user interactions across web and mobile to surface
 * behavioral and product insights.
 *
 * Sector: Digital / experience analytics. HQ: Paris, Ile-de-France, France.
 *
 * Source: Lever job board, company slug `contentsquare`
 * (`https://jobs.lever.co/contentsquare`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'contentsquare';
const COMPANY_NAME = 'Contentsquare';

@SourcePlugin({
  site: Site.CONTENTSQUARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ContentsquareService implements IScraper {
  private readonly logger = new Logger(ContentsquareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Contentsquare',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Contentsquare: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONTENTSQUARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'contentsquare-');
      }
    }

    this.logger.log(`Contentsquare: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
