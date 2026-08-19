import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * WorkOS — Developer API platform for enterprise-ready application features.
 *
 * WorkOS provides APIs that help SaaS applications add enterprise features
 * such as single sign-on, directory synchronization, user management, and
 * audit logs. It is aimed at making applications enterprise-ready with
 * minimal integration effort.
 *
 * Sector: Developer infrastructure / Identity. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `workos`
 * (`https://jobs.ashbyhq.com/workos`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'workos';
const COMPANY_NAME = 'WorkOS';

@SourcePlugin({
  site: Site.WORKOS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WorkOSService implements IScraper {
  private readonly logger = new Logger(WorkOSService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape WorkOS',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `WorkOS: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WORKOS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'workos-');
      }
    }

    this.logger.log(`WorkOS: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
