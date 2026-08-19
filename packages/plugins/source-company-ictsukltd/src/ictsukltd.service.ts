import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ICTS (UK) Ltd — UK provider of security and aviation-related services.
 *
 * ICTS (UK) Ltd is a United Kingdom-based provider of security services,
 * including aviation security, screening and guarding for commercial and
 * public-sector clients. It is part of the international ICTS group.
 *
 * Sector: Security & aviation services. HQ: United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `ICTSUKLtd`
 * (`https://jobs.smartrecruiters.com/ICTSUKLtd`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ICTSUKLtd';
const COMPANY_NAME = 'ICTS (UK) Ltd';

@SourcePlugin({
  site: Site.ICTS_UK_LTD,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ICTSUKLtdService implements IScraper {
  private readonly logger = new Logger(ICTSUKLtdService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape ICTS (UK) Ltd',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `ICTS (UK) Ltd: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ICTS_UK_LTD;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'ictsukltd-');
      }
    }

    this.logger.log(`ICTS (UK) Ltd: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
