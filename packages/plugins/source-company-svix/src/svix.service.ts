import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Svix — Webhooks-as-a-service platform for developers.
 *
 * Svix provides a webhooks service that lets companies add secure, reliable
 * webhook sending to their products, with an API and management UI. It
 * offers an open-source and enterprise-ready webhooks implementation.
 *
 * Sector: Developer infrastructure / Webhooks. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `svix`
 * (`https://jobs.ashbyhq.com/svix`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'svix';
const COMPANY_NAME = 'Svix';

@SourcePlugin({
  site: Site.SVIX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SvixService implements IScraper {
  private readonly logger = new Logger(SvixService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Svix',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Svix: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SVIX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'svix-');
      }
    }

    this.logger.log(`Svix: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
