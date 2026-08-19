import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Render — Unified cloud platform for building, deploying, and scaling applications.
 *
 * Render provides a unified cloud platform for deploying and managing web
 * applications, APIs, databases, and background services. It offers
 * computing, networking, and storage with Git-based deploys.
 *
 * Sector: Cloud platform / Infrastructure. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `render`
 * (`https://jobs.ashbyhq.com/render`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'render';
const COMPANY_NAME = 'Render';

@SourcePlugin({
  site: Site.RENDER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RenderService implements IScraper {
  private readonly logger = new Logger(RenderService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Render',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Render: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RENDER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'render-');
      }
    }

    this.logger.log(`Render: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
