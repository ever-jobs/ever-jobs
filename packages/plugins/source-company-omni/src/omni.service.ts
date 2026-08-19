import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Omni — Business intelligence and embedded analytics platform.
 *
 * Omni is a business intelligence and embedded analytics platform that
 * supports self-service analysis and customer-facing data products. Based in
 * San Francisco, it has raised $217M from investors, including a $120M
 * Series C. The company hires across Sales, Engineering, Solutions
 * Architecture, Customer Support, and Marketing in the US, EMEA, and APAC.
 *
 * Sector: Analytics / Business Intelligence. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `omni`
 * (`https://jobs.ashbyhq.com/omni`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'omni';
const COMPANY_NAME = 'Omni';

@SourcePlugin({
  site: Site.OMNI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OmniService implements IScraper {
  private readonly logger = new Logger(OmniService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Omni',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Omni: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OMNI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'omni-');
      }
    }

    this.logger.log(`Omni: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
