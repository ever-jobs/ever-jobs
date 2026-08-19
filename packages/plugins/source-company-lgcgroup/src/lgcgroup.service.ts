import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * LGC Group — Life sciences measurement and standards company serving diagnostics, pharma, and research markets.
 *
 * LGC Group is a global life sciences company providing reference standards,
 * genomics tools, and diagnostic and reagent components for the life
 * sciences and diagnostics industries. It supports pharmaceutical, clinical,
 * and research customers. The company is headquartered in Teddington, UK.
 *
 * Sector: Life Sciences / Diagnostics. HQ: Teddington, London, United Kingdom.
 *
 * Source: SmartRecruiters job board, company identifier `LGCGroup`
 * (`https://jobs.smartrecruiters.com/LGCGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'LGCGroup';
const COMPANY_NAME = 'LGC Group';

@SourcePlugin({
  site: Site.LGC_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LGCGroupService implements IScraper {
  private readonly logger = new Logger(LGCGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape LGC Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `LGC Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LGC_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'lgcgroup-');
      }
    }

    this.logger.log(`LGC Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
