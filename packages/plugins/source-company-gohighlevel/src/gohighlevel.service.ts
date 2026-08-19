import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * HighLevel — AI-powered business operating system giving agencies and SMBs infrastructure to build, automate, and scale.
 *
 * HighLevel offers an AI-powered business operating platform for agencies,
 * entrepreneurs, and SMBs, providing automation, messaging, and data
 * infrastructure at large scale. The company reports handling billions of
 * API hits and message events daily.
 *
 * Sector: SaaS / automation platform. HQ: Dallas, Texas, United States.
 *
 * Source: Lever job board, company slug `gohighlevel`
 * (`https://jobs.lever.co/gohighlevel`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gohighlevel';
const COMPANY_NAME = 'HighLevel';

@SourcePlugin({
  site: Site.HIGHLEVEL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HighLevelService implements IScraper {
  private readonly logger = new Logger(HighLevelService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape HighLevel',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `HighLevel: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HIGHLEVEL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'gohighlevel-');
      }
    }

    this.logger.log(`HighLevel: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
