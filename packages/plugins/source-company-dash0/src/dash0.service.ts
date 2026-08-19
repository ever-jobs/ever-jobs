import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Dash0 — OpenTelemetry-native observability and monitoring platform.
 *
 * Dash0 builds an OpenTelemetry-native observability platform focused on
 * making observability easier to install, integrate, and manage. The company
 * is in a growth phase following a Series B funding round and hires across
 * Engineering, Sales, and Marketing in EMEA and the US.
 *
 * Sector: Observability. HQ: Remote (EMEA-based).
 *
 * Source: Ashby job board, company slug `dash0`
 * (`https://jobs.ashbyhq.com/dash0`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'dash0';
const COMPANY_NAME = 'Dash0';

@SourcePlugin({
  site: Site.DASH0,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class Dash0Service implements IScraper {
  private readonly logger = new Logger(Dash0Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Dash0',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Dash0: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DASH0;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'dash0-');
      }
    }

    this.logger.log(`Dash0: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
