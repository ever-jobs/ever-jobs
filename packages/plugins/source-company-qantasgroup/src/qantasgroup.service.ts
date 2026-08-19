import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Qantas Group — Australia\'s largest airline group, operating Qantas, Jetstar, and related aviation businesses.
 *
 * The Qantas Group is Australia's largest domestic and international airline
 * group, headquartered in Sydney. It comprises the full-service Qantas
 * brand, low-cost carrier Jetstar, and freight and ground operations. Hiring
 * covers cabin crew, pilots, engineering, and corporate roles.
 *
 * Sector: Airlines. HQ: Sydney, New South Wales, Australia.
 *
 * Source: SmartRecruiters job board, company identifier `QantasGroup`
 * (`https://jobs.smartrecruiters.com/QantasGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'QantasGroup';
const COMPANY_NAME = 'Qantas Group';

@SourcePlugin({
  site: Site.QANTAS_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class QantasGroupService implements IScraper {
  private readonly logger = new Logger(QantasGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Qantas Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Qantas Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.QANTAS_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'qantasgroup-');
      }
    }

    this.logger.log(`Qantas Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
