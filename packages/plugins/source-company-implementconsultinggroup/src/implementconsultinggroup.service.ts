import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Implement Consulting Group — Nordic-headquartered management consultancy with offices across the Nordics and DACH.
 *
 * Implement Consulting Group is an international management consultancy
 * headquartered in the Copenhagen area of Denmark. It advises organisations
 * on strategy, operations, transformation and change, with offices across
 * the Nordics, the DACH region and beyond.
 *
 * Sector: Management consulting. HQ: Hellerup (Copenhagen), Denmark.
 *
 * Source: SmartRecruiters job board, company identifier `ImplementConsultingGroup`
 * (`https://jobs.smartrecruiters.com/ImplementConsultingGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ImplementConsultingGroup';
const COMPANY_NAME = 'Implement Consulting Group';

@SourcePlugin({
  site: Site.IMPLEMENT_CONSULTING_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ImplementConsultingGroupService implements IScraper {
  private readonly logger = new Logger(ImplementConsultingGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Implement Consulting Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Implement Consulting Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.IMPLEMENT_CONSULTING_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'implementconsultinggroup-');
      }
    }

    this.logger.log(`Implement Consulting Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
