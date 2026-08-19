import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SonderMind — Behavioral health platform connecting patients with therapists and psychiatric providers.
 *
 * SonderMind is a behavioral health company that matches individuals with
 * licensed therapists and psychiatric providers. It supports in-network,
 * insurance-based care and provides tools for clinicians to manage their
 * practices. The company operates across multiple US states.
 *
 * Sector: Healthtech (mental health). HQ: Denver, CO, USA.
 *
 * Source: Ashby job board, company slug `sondermind`
 * (`https://jobs.ashbyhq.com/sondermind`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sondermind';
const COMPANY_NAME = 'SonderMind';

@SourcePlugin({
  site: Site.SONDERMIND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SonderMindService implements IScraper {
  private readonly logger = new Logger(SonderMindService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape SonderMind',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `SonderMind: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SONDERMIND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sondermind-');
      }
    }

    this.logger.log(`SonderMind: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
