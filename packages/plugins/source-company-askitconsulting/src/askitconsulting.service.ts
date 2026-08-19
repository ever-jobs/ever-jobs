import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ask IT Consulting — IT consulting, business consulting and outsourcing services firm.
 *
 * Ask IT Consulting provides technology, business consulting and outsourcing
 * services along with IT staffing. It places technology professionals with
 * enterprise and public-sector clients across the United States.
 *
 * Sector: IT consulting and staffing. HQ: Edison, New Jersey, United States.
 *
 * Source: SmartRecruiters job board, company identifier `AskITConsulting`
 * (`https://jobs.smartrecruiters.com/AskITConsulting`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AskITConsulting';
const COMPANY_NAME = 'Ask IT Consulting';

@SourcePlugin({
  site: Site.ASK_IT_CONSULTING,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AskITConsultingService implements IScraper {
  private readonly logger = new Logger(AskITConsultingService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Ask IT Consulting',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ask IT Consulting: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASK_IT_CONSULTING;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'askitconsulting-');
      }
    }

    this.logger.log(`Ask IT Consulting: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
