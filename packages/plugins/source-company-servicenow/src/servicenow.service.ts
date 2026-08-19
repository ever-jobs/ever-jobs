import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ServiceNow — Cloud platform for digital workflows and IT service management.
 *
 * ServiceNow develops a cloud-based platform that automates enterprise IT,
 * employee, and customer workflows. Its Now Platform is used for IT service
 * management, operations, security, and low-code application development.
 * The company serves large enterprises globally.
 *
 * Sector: Enterprise software (cloud workflow / ITSM platform). HQ: Santa Clara, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `ServiceNow`
 * (`https://jobs.smartrecruiters.com/ServiceNow`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ServiceNow';
const COMPANY_NAME = 'ServiceNow';

@SourcePlugin({
  site: Site.SERVICENOW,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ServiceNowService implements IScraper {
  private readonly logger = new Logger(ServiceNowService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape ServiceNow',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `ServiceNow: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SERVICENOW;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'servicenow-');
      }
    }

    this.logger.log(`ServiceNow: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
