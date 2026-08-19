import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Verifiable — AI, API, and software platform for healthcare provider credentialing and network monitoring.
 *
 * Verifiable provides an API-driven platform for healthcare provider
 * credentialing and network monitoring, helping healthcare organizations
 * automate compliance operations at enterprise scale. Roles are largely
 * remote.
 *
 * Sector: Healthcare API / SaaS platform. HQ: United States (remote-first).
 *
 * Source: Lever job board, company slug `verifiable`
 * (`https://jobs.lever.co/verifiable`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'verifiable';
const COMPANY_NAME = 'Verifiable';

@SourcePlugin({
  site: Site.VERIFIABLE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VerifiableService implements IScraper {
  private readonly logger = new Logger(VerifiableService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Verifiable',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Verifiable: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VERIFIABLE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'verifiable-');
      }
    }

    this.logger.log(`Verifiable: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
