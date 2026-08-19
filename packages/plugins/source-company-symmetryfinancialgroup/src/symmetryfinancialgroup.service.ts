import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Symmetry Financial Group — US insurance distribution organization focused on life and mortgage protection.
 *
 * Symmetry Financial Group is a US-based insurance marketing and
 * distribution organization. It sells life insurance and mortgage protection
 * products through a network of independent agents.
 *
 * Sector: Insurance distribution. HQ: Swannanoa, North Carolina, USA.
 *
 * Source: SmartRecruiters job board, company identifier `SymmetryFinancialGroup7`
 * (`https://jobs.smartrecruiters.com/SymmetryFinancialGroup7`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'SymmetryFinancialGroup7';
const COMPANY_NAME = 'Symmetry Financial Group';

@SourcePlugin({
  site: Site.SYMMETRY_FINANCIAL_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SymmetryFinancialGroupService implements IScraper {
  private readonly logger = new Logger(SymmetryFinancialGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Symmetry Financial Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Symmetry Financial Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SYMMETRY_FINANCIAL_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'symmetryfinancialgroup-');
      }
    }

    this.logger.log(`Symmetry Financial Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
