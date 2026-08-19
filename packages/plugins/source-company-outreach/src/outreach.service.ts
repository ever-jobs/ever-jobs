import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Outreach — Sales execution and engagement platform for revenue teams.
 *
 * Outreach builds a sales execution platform that helps revenue teams manage
 * prospecting, deal workflows, and forecasting. It sells to enterprise and
 * mid-market sales organizations.
 *
 * Sector: B2B SaaS / Sales Engagement. HQ: Seattle, Washington, United States.
 *
 * Source: Lever job board, company slug `outreach`
 * (`https://jobs.lever.co/outreach`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'outreach';
const COMPANY_NAME = 'Outreach';

@SourcePlugin({
  site: Site.OUTREACH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OutreachService implements IScraper {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Outreach',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Outreach: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OUTREACH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'outreach-');
      }
    }

    this.logger.log(`Outreach: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
