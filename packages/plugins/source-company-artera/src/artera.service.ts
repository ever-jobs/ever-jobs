import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Artera — Develops AI-based medical tests to personalize cancer therapy decisions.
 *
 * Artera develops medical artificial intelligence tests that personalize
 * therapy for cancer patients. It builds core ML libraries and compute
 * infrastructure to support foundation-model development for its tests.
 *
 * Sector: Applied AI / healthcare. HQ: Los Altos, California, USA.
 *
 * Source: Lever job board, company slug `artera`
 * (`https://jobs.lever.co/artera`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'artera';
const COMPANY_NAME = 'Artera';

@SourcePlugin({
  site: Site.ARTERA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ArteraService implements IScraper {
  private readonly logger = new Logger(ArteraService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Artera',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Artera: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARTERA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'artera-');
      }
    }

    this.logger.log(`Artera: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
