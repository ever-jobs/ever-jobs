import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Proxima Fusion — Develops stellarator-based fusion power plants for clean energy generation.
 *
 * Proxima Fusion is a German fusion energy company developing stellarator
 * technology with the goal of building commercial fusion power plants. It
 * emerged from research associated with the Max Planck Institute for Plasma
 * Physics. The company is based in Munich.
 *
 * Sector: Fusion energy. HQ: Munich, Germany.
 *
 * Source: Ashby job board, company slug `proxima-fusion`
 * (`https://jobs.ashbyhq.com/proxima-fusion`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'proxima-fusion';
const COMPANY_NAME = 'Proxima Fusion';

@SourcePlugin({
  site: Site.PROXIMA_FUSION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ProximaFusionService implements IScraper {
  private readonly logger = new Logger(ProximaFusionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Proxima Fusion',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Proxima Fusion: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PROXIMA_FUSION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'proximafusion-');
      }
    }

    this.logger.log(`Proxima Fusion: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
