import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Zapier — No-code automation platform connecting thousands of web apps.
 *
 * Zapier is a workflow-automation platform that lets users connect web
 * applications and automate tasks without code through automated workflows
 * called Zaps. It integrates with thousands of apps. The company operates as
 * a fully remote organization.
 *
 * Sector: B2B SaaS / workflow automation. HQ: Remote (Sunnyvale, California, USA).
 *
 * Source: Ashby job board, company slug `zapier`
 * (`https://jobs.ashbyhq.com/zapier`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'zapier';
const COMPANY_NAME = 'Zapier';

@SourcePlugin({
  site: Site.ZAPIER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ZapierService implements IScraper {
  private readonly logger = new Logger(ZapierService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Zapier',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Zapier: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ZAPIER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'zapier-');
      }
    }

    this.logger.log(`Zapier: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
