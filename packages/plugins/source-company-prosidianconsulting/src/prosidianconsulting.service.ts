import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ProSidian Consulting — Management and operations consulting firm serving government and commercial clients.
 *
 * ProSidian Consulting is a management and operations consulting services
 * firm providing solutions in risk management, compliance, business process,
 * IT effectiveness, engineering, environmental, sustainability and human
 * capital. It serves federal government and commercial clients across the
 * United States.
 *
 * Sector: Management and operations consulting. HQ: Charlotte, North Carolina, United States.
 *
 * Source: SmartRecruiters job board, company identifier `prosidianconsulting`
 * (`https://jobs.smartrecruiters.com/prosidianconsulting`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'prosidianconsulting';
const COMPANY_NAME = 'ProSidian Consulting';

@SourcePlugin({
  site: Site.PROSIDIAN_CONSULTING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ProSidianConsultingService implements IScraper {
  private readonly logger = new Logger(ProSidianConsultingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape ProSidian Consulting',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `ProSidian Consulting: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PROSIDIAN_CONSULTING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'prosidianconsulting-');
      }
    }

    this.logger.log(`ProSidian Consulting: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
