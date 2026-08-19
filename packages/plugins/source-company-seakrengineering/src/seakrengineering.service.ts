import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SEAKR Engineering — Manufacturer of advanced electronics for space and satellite applications.
 *
 * SEAKR Engineering designs and manufactures advanced electronics for space
 * applications, including onboard processing, memory, and signal-processing
 * systems for satellites and spacecraft.
 *
 * Sector: Aerospace electronics manufacturing. HQ: Centennial, Colorado, USA.
 *
 * Source: SmartRecruiters job board, company identifier `SEAKREngineering`
 * (`https://jobs.smartrecruiters.com/SEAKREngineering`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SEAKREngineering';
const COMPANY_NAME = 'SEAKR Engineering';

@SourcePlugin({
  site: Site.SEAKR_ENGINEERING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SEAKREngineeringService implements IScraper {
  private readonly logger = new Logger(SEAKREngineeringService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape SEAKR Engineering',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `SEAKR Engineering: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SEAKR_ENGINEERING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'seakrengineering-');
      }
    }

    this.logger.log(`SEAKR Engineering: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
