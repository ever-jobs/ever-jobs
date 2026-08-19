import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Spectrum Health Care — Canadian provider of home health care, personal support, and community nursing services.
 *
 * Spectrum Health Care is a Canadian home and community health care provider
 * delivering nursing, personal support, and related services to clients in
 * their homes and in the community. It operates across Ontario. The
 * organization supports seniors and patients requiring in-home care.
 *
 * Sector: Home Health Care. HQ: Toronto, Ontario, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `SpectrumHealthCare`
 * (`https://jobs.smartrecruiters.com/SpectrumHealthCare`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SpectrumHealthCare';
const COMPANY_NAME = 'Spectrum Health Care';

@SourcePlugin({
  site: Site.SPECTRUM_HEALTH_CARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpectrumHealthCareService implements IScraper {
  private readonly logger = new Logger(SpectrumHealthCareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Spectrum Health Care',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Spectrum Health Care: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPECTRUM_HEALTH_CARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'spectrumhealthcare-');
      }
    }

    this.logger.log(`Spectrum Health Care: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
