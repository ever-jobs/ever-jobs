import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Waabi — AI-first autonomous driving technology for trucking and robotaxis.
 *
 * Waabi develops autonomous driving software using an AI-first,
 * simulation-driven approach for heavy trucks and other vehicles. It focuses
 * on generative AI and closed-loop simulation for self-driving.
 *
 * Sector: Autonomous Vehicles. HQ: Toronto, Ontario, Canada.
 *
 * Source: Lever job board, company slug `waabi`
 * (`https://jobs.lever.co/waabi`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'waabi';
const COMPANY_NAME = 'Waabi';

@SourcePlugin({
  site: Site.WAABI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WaabiService implements IScraper {
  private readonly logger = new Logger(WaabiService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Waabi',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Waabi: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WAABI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'waabi-');
      }
    }

    this.logger.log(`Waabi: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
