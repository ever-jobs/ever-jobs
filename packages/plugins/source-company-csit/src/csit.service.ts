import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Centre for Strategic Infocomm Technologies (CSIT) — Singapore government agency conducting cybersecurity R&D and building capabilities to defend against advanced cyber threats.
 *
 * The Centre for Strategic Infocomm Technologies (CSIT) is an agency under
 * Singapore's Ministry of Defence that conducts research and development to
 * uncover system vulnerabilities and defend against advanced cyber threats
 * across cloud, enterprise, mobile, and critical-infrastructure platforms.
 *
 * Sector: Cybersecurity (Government / National Security R&D). HQ: Singapore, Singapore.
 *
 * Source: Lever job board, company slug `csit`
 * (`https://jobs.lever.co/csit`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'csit';
const COMPANY_NAME = 'Centre for Strategic Infocomm Technologies (CSIT)';

@SourcePlugin({
  site: Site.CENTRE_FOR_STRATEGIC_INFOCOMM_TECHNOLOGIES_CSIT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CentreForStrategicInfocommTechnologiesCSITService implements IScraper {
  private readonly logger = new Logger(CentreForStrategicInfocommTechnologiesCSITService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Centre for Strategic Infocomm Technologies (CSIT)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Centre for Strategic Infocomm Technologies (CSIT): delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CENTRE_FOR_STRATEGIC_INFOCOMM_TECHNOLOGIES_CSIT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'csit-');
      }
    }

    this.logger.log(`Centre for Strategic Infocomm Technologies (CSIT): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
