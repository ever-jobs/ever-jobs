import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Netspend — A provider of prepaid and debit card financial services for consumers.
 *
 * Netspend provides prepaid and debit card products and related financial
 * services aimed at consumers, including those underserved by traditional
 * banks. It manages debit and prepaid card portfolios.
 *
 * Sector: Fintech - Prepaid & debit cards. HQ: Austin, Texas, USA.
 *
 * Source: Ashby job board, company slug `netspend-careers-page`
 * (`https://jobs.ashbyhq.com/netspend-careers-page`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'netspend-careers-page';
const COMPANY_NAME = 'Netspend';

@SourcePlugin({
  site: Site.NETSPEND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NetspendService implements IScraper {
  private readonly logger = new Logger(NetspendService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Netspend',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Netspend: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NETSPEND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'netspend-');
      }
    }

    this.logger.log(`Netspend: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
