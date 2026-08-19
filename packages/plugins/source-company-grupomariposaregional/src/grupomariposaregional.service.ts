import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Grupo Mariposa (Regional) — Regional careers channel of the Central American food and beverage conglomerate.
 *
 * This is a secondary SmartRecruiters careers channel for Grupo Mariposa,
 * the Guatemala-based food and beverage group whose business spans beverage
 * bottling and distribution, snacks, and other consumer packaged goods
 * across Latin America.
 *
 * Sector: Food & Beverage (Bottling & Consumer Goods). HQ: Guatemala City, Guatemala.
 *
 * Source: SmartRecruiters job board, company identifier `GrupoMariposa`
 * (`https://jobs.smartrecruiters.com/GrupoMariposa`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'GrupoMariposa';
const COMPANY_NAME = 'Grupo Mariposa (Regional)';

@SourcePlugin({
  site: Site.GRUPO_MARIPOSA_REGIONAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GrupoMariposaRegionalService implements IScraper {
  private readonly logger = new Logger(GrupoMariposaRegionalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Grupo Mariposa (Regional)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Grupo Mariposa (Regional): delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GRUPO_MARIPOSA_REGIONAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'grupomariposaregional-');
      }
    }

    this.logger.log(`Grupo Mariposa (Regional): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
