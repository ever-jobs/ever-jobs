import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Material Security — Security platform protecting cloud email and productivity accounts.
 *
 * Material Security provides a platform that protects cloud email and
 * workspace environments against threats such as account takeover, phishing,
 * and data exposure. It focuses on securing Google Workspace and Microsoft
 * 365 accounts and their data.
 *
 * Sector: Email & Cloud Security. HQ: Redwood City, California, United States.
 *
 * Source: Ashby job board, company slug `materialsecurity`
 * (`https://jobs.ashbyhq.com/materialsecurity`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'materialsecurity';
const COMPANY_NAME = 'Material Security';

@SourcePlugin({
  site: Site.MATERIAL_SECURITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MaterialSecurityService implements IScraper {
  private readonly logger = new Logger(MaterialSecurityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Material Security',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Material Security: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MATERIAL_SECURITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'materialsecurity-');
      }
    }

    this.logger.log(`Material Security: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
