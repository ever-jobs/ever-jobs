import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Telefónica Tech — Digital services and technology unit of the Telefónica telecommunications group.
 *
 * Telefónica Tech is the digital business unit of the Telefónica group,
 * providing cloud, cybersecurity, IoT and data services to businesses. It
 * hires technology consultants, engineers and specialist roles across its
 * markets.
 *
 * Sector: Telecommunications / Digital Services. HQ: Madrid, Spain.
 *
 * Source: SmartRecruiters job board, company identifier `telefonicatech`
 * (`https://jobs.smartrecruiters.com/telefonicatech`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'telefonicatech';
const COMPANY_NAME = 'Telefónica Tech';

@SourcePlugin({
  site: Site.TELEF_NICA_TECH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TelefNicaTechService implements IScraper {
  private readonly logger = new Logger(TelefNicaTechService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Telefónica Tech',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Telefónica Tech: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TELEF_NICA_TECH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'telefnicatech-');
      }
    }

    this.logger.log(`Telefónica Tech: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
