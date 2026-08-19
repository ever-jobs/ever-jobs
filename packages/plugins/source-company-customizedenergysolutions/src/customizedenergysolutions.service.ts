import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Customized Energy Solutions — Provider of market intelligence and operational support services for electricity and natural gas markets.
 *
 * Customized Energy Solutions provides market intelligence, regulatory
 * support and operational services in the wholesale and retail electricity
 * and natural gas markets. It acts as a third-party asset manager for
 * renewable and conventional generation resources across North American
 * ISOs.
 *
 * Sector: Energy Services. HQ: Philadelphia, Pennsylvania, United States.
 *
 * Source: SmartRecruiters job board, company identifier `CustomizedEnergySolutions`
 * (`https://jobs.smartrecruiters.com/CustomizedEnergySolutions`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CustomizedEnergySolutions';
const COMPANY_NAME = 'Customized Energy Solutions';

@SourcePlugin({
  site: Site.CUSTOMIZED_ENERGY_SOLUTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CustomizedEnergySolutionsService implements IScraper {
  private readonly logger = new Logger(CustomizedEnergySolutionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Customized Energy Solutions',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Customized Energy Solutions: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CUSTOMIZED_ENERGY_SOLUTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'customizedenergysolutions-');
      }
    }

    this.logger.log(`Customized Energy Solutions: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
