import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Speakeasy — API tooling for generating SDKs, docs, and Terraform providers.
 *
 * Speakeasy provides API tooling that generates client SDKs, API
 * documentation, Terraform providers, and end-to-end testing from API
 * specifications. It helps API-first companies ship and maintain developer
 * integrations.
 *
 * Sector: Developer tools / API tooling. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `speakeasy`
 * (`https://jobs.ashbyhq.com/speakeasy`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'speakeasy';
const COMPANY_NAME = 'Speakeasy';

@SourcePlugin({
  site: Site.SPEAKEASY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpeakeasyService implements IScraper {
  private readonly logger = new Logger(SpeakeasyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Speakeasy',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Speakeasy: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPEAKEASY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'speakeasy-');
      }
    }

    this.logger.log(`Speakeasy: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
