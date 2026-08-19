import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CaptivateIQ — Sales performance and incentive compensation management platform.
 *
 * CaptivateIQ provides software for incentive compensation management and
 * broader sales planning, letting revenue teams design, run, and analyze
 * commission plans. It hires remotely with a hub in Austin and roles in
 * Poland.
 *
 * Sector: B2B SaaS / Sales Performance Management. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `captivateiq`
 * (`https://jobs.lever.co/captivateiq`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'captivateiq';
const COMPANY_NAME = 'CaptivateIQ';

@SourcePlugin({
  site: Site.CAPTIVATEIQ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CaptivateIQService implements IScraper {
  private readonly logger = new Logger(CaptivateIQService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape CaptivateIQ',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `CaptivateIQ: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CAPTIVATEIQ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'captivateiq-');
      }
    }

    this.logger.log(`CaptivateIQ: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
