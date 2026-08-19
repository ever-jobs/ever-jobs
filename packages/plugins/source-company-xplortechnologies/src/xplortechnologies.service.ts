import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Xplor Technologies — Provider of vertical software and embedded payments for businesses.
 *
 * Xplor Technologies builds vertical-market software and embedded payment
 * solutions for industries such as fitness, recreation, field services, and
 * education. It combines business management software with integrated
 * payment processing. It serves businesses across many countries.
 *
 * Sector: Vertical SaaS and embedded payments software. HQ: Atlanta, Georgia, USA.
 *
 * Source: SmartRecruiters job board, company identifier `Xplor`
 * (`https://jobs.smartrecruiters.com/Xplor`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Xplor';
const COMPANY_NAME = 'Xplor Technologies';

@SourcePlugin({
  site: Site.XPLOR_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class XplorTechnologiesService implements IScraper {
  private readonly logger = new Logger(XplorTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Xplor Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Xplor Technologies: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.XPLOR_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'xplortechnologies-');
      }
    }

    this.logger.log(`Xplor Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
