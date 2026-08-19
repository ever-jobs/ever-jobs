import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Quest Diagnostics — Provider of clinical laboratory testing, diagnostic information services, and related products.
 *
 * Quest Diagnostics is a US clinical laboratory company providing diagnostic
 * testing, information, and services to patients, physicians, hospitals, and
 * health plans. It operates a national network of laboratories and patient
 * service centers. The company is headquartered in Secaucus, New Jersey.
 *
 * Sector: Diagnostics / Clinical Laboratory. HQ: Secaucus, New Jersey, USA.
 *
 * Source: SmartRecruiters job board, company identifier `QuestDiagnostics7`
 * (`https://jobs.smartrecruiters.com/QuestDiagnostics7`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'QuestDiagnostics7';
const COMPANY_NAME = 'Quest Diagnostics';

@SourcePlugin({
  site: Site.QUEST_DIAGNOSTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class QuestDiagnosticsService implements IScraper {
  private readonly logger = new Logger(QuestDiagnosticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Quest Diagnostics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Quest Diagnostics: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.QUEST_DIAGNOSTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'questdiagnostics-');
      }
    }

    this.logger.log(`Quest Diagnostics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
