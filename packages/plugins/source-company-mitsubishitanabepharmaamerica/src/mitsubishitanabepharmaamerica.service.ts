import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mitsubishi Tanabe Pharma America — US subsidiary of Mitsubishi Tanabe Pharma developing and commercializing medicines.
 *
 * Mitsubishi Tanabe Pharma America is the US arm of Japan-based Mitsubishi
 * Tanabe Pharma Corporation, focused on developing and commercializing
 * pharmaceutical products, including therapies in areas such as neurology.
 * It is headquartered in Jersey City, New Jersey.
 *
 * Sector: Pharmaceuticals. HQ: Jersey City, New Jersey, USA.
 *
 * Source: SmartRecruiters job board, company identifier `MitsubishiTanabePharmaAmerica`
 * (`https://jobs.smartrecruiters.com/MitsubishiTanabePharmaAmerica`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'MitsubishiTanabePharmaAmerica';
const COMPANY_NAME = 'Mitsubishi Tanabe Pharma America';

@SourcePlugin({
  site: Site.MITSUBISHI_TANABE_PHARMA_AMERICA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MitsubishiTanabePharmaAmericaService implements IScraper {
  private readonly logger = new Logger(MitsubishiTanabePharmaAmericaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Mitsubishi Tanabe Pharma America',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mitsubishi Tanabe Pharma America: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MITSUBISHI_TANABE_PHARMA_AMERICA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'mitsubishitanabepharmaamerica-');
      }
    }

    this.logger.log(`Mitsubishi Tanabe Pharma America: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
