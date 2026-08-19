import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ClickUp — All-in-one productivity platform for tasks, docs, goals, and project management.
 *
 * ClickUp is a productivity and project-management platform that combines
 * tasks, documents, goals, dashboards, and chat in one application. It is
 * aimed at helping teams consolidate work across multiple tools. The company
 * is headquartered in San Diego.
 *
 * Sector: Productivity & collaboration software. HQ: San Diego, California, USA.
 *
 * Source: Ashby job board, company slug `clickup`
 * (`https://jobs.ashbyhq.com/clickup`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'clickup';
const COMPANY_NAME = 'ClickUp';

@SourcePlugin({
  site: Site.CLICKUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ClickUpService implements IScraper {
  private readonly logger = new Logger(ClickUpService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape ClickUp',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `ClickUp: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CLICKUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'clickup-');
      }
    }

    this.logger.log(`ClickUp: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
