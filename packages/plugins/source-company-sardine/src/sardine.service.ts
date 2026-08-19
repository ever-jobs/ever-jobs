import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sardine — Risk platform for fraud prevention, compliance, and financial-crime detection.
 *
 * Sardine provides a risk platform that unifies data across fraud,
 * compliance, and risk teams to detect and stop financial crime in real time
 * and automate fraud and AML operations. Customers include companies such as
 * FIS, GoDaddy, and Checkout.com.
 *
 * Sector: Fraud & Risk. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `sardine`
 * (`https://jobs.ashbyhq.com/sardine`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sardine';
const COMPANY_NAME = 'Sardine';

@SourcePlugin({
  site: Site.SARDINE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SardineService implements IScraper {
  private readonly logger = new Logger(SardineService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Sardine',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sardine: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SARDINE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sardine-');
      }
    }

    this.logger.log(`Sardine: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
