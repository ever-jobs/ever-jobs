import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * cbs Corporate Business Solutions — Digital end-to-end business-process and SAP transformation solutions.
 *
 * cbs Corporate Business Solutions GmbH delivers digital end-to-end
 * business-process solutions with a focus on SAP consulting, system
 * transformation, and business-process management for manufacturing,
 * automotive, pharma, and life-science industries. It is headquartered in
 * Heidelberg.
 *
 * Sector: Enterprise software / SAP consulting. HQ: Heidelberg, Germany.
 *
 * Source: Recruitee careers board, subdomain `cbsconsulting`
 * (`https://cbsconsulting.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'cbsconsulting';
const COMPANY_NAME = 'cbs Corporate Business Solutions';

@SourcePlugin({
  site: Site.CBS_CORPORATE_BUSINESS_SOLUTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CbsCorporateBusinessSolutionsService implements IScraper {
  private readonly logger = new Logger(CbsCorporateBusinessSolutionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape cbs Corporate Business Solutions',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `cbs Corporate Business Solutions: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CBS_CORPORATE_BUSINESS_SOLUTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'cbscorporatebusinesssolutions-');
      }
    }

    this.logger.log(`cbs Corporate Business Solutions: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
