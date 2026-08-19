import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Palantir Technologies — Builds data-integration and AI platforms for government and commercial operations.
 *
 * Palantir Technologies builds software platforms (Foundry, Gotham, AIP) for
 * data integration, analytics and AI-driven operational decision-making
 * across government and commercial customers. It runs Forward Deployed AI
 * Engineering teams that build LLM workflows in production.
 *
 * Sector: AI / data and analytics platforms. HQ: Denver, Colorado, USA.
 *
 * Source: Lever job board, company slug `palantir`
 * (`https://jobs.lever.co/palantir`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'palantir';
const COMPANY_NAME = 'Palantir Technologies';

@SourcePlugin({
  site: Site.PALANTIR_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PalantirTechnologiesService implements IScraper {
  private readonly logger = new Logger(PalantirTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Palantir Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Palantir Technologies: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PALANTIR_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'palantir-');
      }
    }

    this.logger.log(`Palantir Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
