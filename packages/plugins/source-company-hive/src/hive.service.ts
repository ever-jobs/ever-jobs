import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hive — Provides cloud-based AI models and APIs for content understanding and moderation.
 *
 * Hive builds and serves AI models via APIs for content moderation, content
 * understanding, and related visual and language AI tasks. It sells these
 * capabilities to enterprises and platforms.
 *
 * Sector: Applied AI / content moderation. HQ: San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `hive`
 * (`https://jobs.lever.co/hive`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'hive';
const COMPANY_NAME = 'Hive';

@SourcePlugin({
  site: Site.HIVE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HiveService implements IScraper {
  private readonly logger = new Logger(HiveService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Hive',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hive: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIVE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'hive-');
      }
    }

    this.logger.log(`Hive: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
