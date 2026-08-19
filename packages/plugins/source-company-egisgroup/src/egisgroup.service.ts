import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Egis Group — International consulting, construction engineering, and operating firm active in infrastructure and mobility.
 *
 * Egis is an international group operating in architecture, consulting,
 * construction engineering, and mobility services. It designs and manages
 * infrastructure and building projects, and operates transport and other
 * facilities. The company works across roughly 100 countries.
 *
 * Sector: Construction Engineering & Infrastructure. HQ: Guyancourt, France.
 *
 * Source: SmartRecruiters job board, company identifier `EgisGroup`
 * (`https://jobs.smartrecruiters.com/EgisGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'EgisGroup';
const COMPANY_NAME = 'Egis Group';

@SourcePlugin({
  site: Site.EGIS_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EgisGroupService implements IScraper {
  private readonly logger = new Logger(EgisGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Egis Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Egis Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EGIS_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'egisgroup-');
      }
    }

    this.logger.log(`Egis Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
