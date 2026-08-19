import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Kepler Communications — In-space data relay network connecting satellites in real time.
 *
 * Kepler Communications is building an optical data relay constellation to
 * provide real-time connectivity for satellites and other space-based
 * assets. It designs and operates its own spacecraft.
 *
 * Sector: Space/Aerospace. HQ: Toronto, Ontario, Canada.
 *
 * Source: Lever job board, company slug `kepler`
 * (`https://jobs.lever.co/kepler`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'kepler';
const COMPANY_NAME = 'Kepler Communications';

@SourcePlugin({
  site: Site.KEPLER_COMMUNICATIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KeplerCommunicationsService implements IScraper {
  private readonly logger = new Logger(KeplerCommunicationsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Kepler Communications',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Kepler Communications: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KEPLER_COMMUNICATIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'kepler-');
      }
    }

    this.logger.log(`Kepler Communications: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
