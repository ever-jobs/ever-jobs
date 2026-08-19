import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Doppler — Cloud-based secrets management platform for development teams.
 *
 * Doppler provides a developer-first secrets management platform that
 * centralizes and controls application secrets across environments. It helps
 * teams orchestrate and govern configuration and credentials at scale.
 *
 * Sector: Developer infrastructure / Secrets management. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `doppler`
 * (`https://jobs.ashbyhq.com/doppler`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'doppler';
const COMPANY_NAME = 'Doppler';

@SourcePlugin({
  site: Site.DOPPLER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DopplerService implements IScraper {
  private readonly logger = new Logger(DopplerService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Doppler',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Doppler: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DOPPLER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'doppler-');
      }
    }

    this.logger.log(`Doppler: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
