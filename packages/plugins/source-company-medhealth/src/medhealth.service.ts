import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * MedHealth — Group of health, medical, and employment services businesses operating primarily in Australia.
 *
 * MedHealth is an Australian group of businesses providing health, medical,
 * and employment services, including occupational health, allied health,
 * medical assessments, and disability and injury management. It operates a
 * portfolio of specialist brands across Australia and New Zealand.
 *
 * Sector: Healthcare Services. HQ: Sydney, New South Wales, Australia.
 *
 * Source: SmartRecruiters job board, company identifier `medhealth3`
 * (`https://jobs.smartrecruiters.com/medhealth3`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'medhealth3';
const COMPANY_NAME = 'MedHealth';

@SourcePlugin({
  site: Site.MEDHEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MedHealthService implements IScraper {
  private readonly logger = new Logger(MedHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape MedHealth',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `MedHealth: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MEDHEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'medhealth-');
      }
    }

    this.logger.log(`MedHealth: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
