import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Quantum Metric — Continuous product and digital analytics platform for monitoring and optimizing digital journeys.
 *
 * Quantum Metric offers a continuous product design and digital analytics
 * platform that helps organizations monitor, diagnose, and optimize digital
 * customer journeys using behavioral and session data.
 *
 * Sector: Digital / product analytics. HQ: Colorado Springs, Colorado, United States.
 *
 * Source: Lever job board, company slug `quantummetric`
 * (`https://jobs.lever.co/quantummetric`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'quantummetric';
const COMPANY_NAME = 'Quantum Metric';

@SourcePlugin({
  site: Site.QUANTUM_METRIC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class QuantumMetricService implements IScraper {
  private readonly logger = new Logger(QuantumMetricService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Quantum Metric',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Quantum Metric: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.QUANTUM_METRIC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'quantummetric-');
      }
    }

    this.logger.log(`Quantum Metric: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
