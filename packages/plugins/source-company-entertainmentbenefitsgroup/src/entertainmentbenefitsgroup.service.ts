import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Entertainment Benefits Group — E-commerce provider of entertainment, travel and attraction offerings.
 *
 * Entertainment Benefits Group is an e-commerce company that provides access
 * to entertainment, travel and attraction offerings and operates related
 * consumer platforms. It hires across e-commerce, operations, marketing and
 * corporate roles.
 *
 * Sector: Entertainment & Travel Commerce. HQ: Austin, Texas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `EntertainmentBenefitsGroup`
 * (`https://jobs.smartrecruiters.com/EntertainmentBenefitsGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'EntertainmentBenefitsGroup';
const COMPANY_NAME = 'Entertainment Benefits Group';

@SourcePlugin({
  site: Site.ENTERTAINMENT_BENEFITS_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EntertainmentBenefitsGroupService implements IScraper {
  private readonly logger = new Logger(EntertainmentBenefitsGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Entertainment Benefits Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Entertainment Benefits Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ENTERTAINMENT_BENEFITS_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'entertainmentbenefitsgroup-');
      }
    }

    this.logger.log(`Entertainment Benefits Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
