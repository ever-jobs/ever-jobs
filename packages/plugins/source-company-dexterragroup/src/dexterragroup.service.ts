import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Dexterra Group — Provider of facilities management, workforce accommodations, and industrial support services.
 *
 * Dexterra Group Inc. is a publicly listed Canadian company (TSX:DXT)
 * providing integrated facilities management, workforce accommodations, and
 * support services across industrial, commercial, and remote-site markets in
 * North America.
 *
 * Sector: Facilities management / Industrial services. HQ: Toronto, Ontario, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `Dexterra`
 * (`https://jobs.smartrecruiters.com/Dexterra`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Dexterra';
const COMPANY_NAME = 'Dexterra Group';

@SourcePlugin({
  site: Site.DEXTERRA_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DexterraGroupService implements IScraper {
  private readonly logger = new Logger(DexterraGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Dexterra Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Dexterra Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DEXTERRA_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'dexterragroup-');
      }
    }

    this.logger.log(`Dexterra Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
