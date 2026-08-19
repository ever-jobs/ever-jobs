import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Tahoe Therapeutics — Applies machine learning to biological data for drug discovery.
 *
 * Tahoe Therapeutics applies machine learning to large-scale biological
 * datasets for drug discovery, hiring ML engineering and ML science roles.
 *
 * Sector: Applied AI / drug discovery. HQ: South San Francisco, California, USA.
 *
 * Source: Lever job board, company slug `tahoebio-ai`
 * (`https://jobs.lever.co/tahoebio-ai`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tahoebio-ai';
const COMPANY_NAME = 'Tahoe Therapeutics';

@SourcePlugin({
  site: Site.TAHOE_THERAPEUTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TahoeTherapeuticsService implements IScraper {
  private readonly logger = new Logger(TahoeTherapeuticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Tahoe Therapeutics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Tahoe Therapeutics: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TAHOE_THERAPEUTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'tahoebioai-');
      }
    }

    this.logger.log(`Tahoe Therapeutics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
