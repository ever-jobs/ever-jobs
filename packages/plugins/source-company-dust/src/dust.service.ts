import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Dust — Platform for building and deploying AI agents connected to company data and tools.
 *
 * Dust provides a platform for building, deploying, and managing AI agents
 * that connect to a company's knowledge, tools, and workflows in a shared
 * workspace. It is aimed at teams operationalizing AI across functions. The
 * company is based in Paris.
 *
 * Sector: B2B SaaS / AI collaboration software. HQ: Paris, France.
 *
 * Source: Ashby job board, company slug `dust`
 * (`https://jobs.ashbyhq.com/dust`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'dust';
const COMPANY_NAME = 'Dust';

@SourcePlugin({
  site: Site.DUST,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DustService implements IScraper {
  private readonly logger = new Logger(DustService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Dust',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Dust: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DUST;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'dust-');
      }
    }

    this.logger.log(`Dust: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
