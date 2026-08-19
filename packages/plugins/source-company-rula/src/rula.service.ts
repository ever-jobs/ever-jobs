import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Rula — Behavioral health platform connecting patients with in-network therapists and psychiatric providers.
 *
 * Rula is a behavioral health company that matches patients with licensed
 * therapists and psychiatric providers and supports insurance-based care. It
 * provides clinicians with tools to manage scheduling, documentation, and
 * billing. The company operates across many US states.
 *
 * Sector: Healthtech (mental health). HQ: Los Angeles, CA, USA.
 *
 * Source: Ashby job board, company slug `rula`
 * (`https://jobs.ashbyhq.com/rula`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'rula';
const COMPANY_NAME = 'Rula';

@SourcePlugin({
  site: Site.RULA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RulaService implements IScraper {
  private readonly logger = new Logger(RulaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Rula',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Rula: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RULA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'rula-');
      }
    }

    this.logger.log(`Rula: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
