import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * The Wonderful Company — Agriculture and consumer-brands company producing produce, nuts, and beverages.
 *
 * The Wonderful Company is a US agriculture and consumer packaged goods
 * company. Its brands include Wonderful Pistachios & Almonds, Wonderful
 * Halos citrus, POM Wonderful, FIJI Water, and Wonderful Pistachios. It
 * operates farming, processing, and beverage manufacturing, and is
 * headquartered in Los Angeles.
 *
 * Sector: Agriculture & Beverages. HQ: Los Angeles, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `TheWonderfulCompany`
 * (`https://jobs.smartrecruiters.com/TheWonderfulCompany`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'TheWonderfulCompany';
const COMPANY_NAME = 'The Wonderful Company';

@SourcePlugin({
  site: Site.THE_WONDERFUL_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TheWonderfulCompanyService implements IScraper {
  private readonly logger = new Logger(TheWonderfulCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape The Wonderful Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `The Wonderful Company: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.THE_WONDERFUL_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'thewonderfulcompany-');
      }
    }

    this.logger.log(`The Wonderful Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
