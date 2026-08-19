import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Notion — Connected workspace combining notes, docs, wikis, databases, and project management.
 *
 * Notion is a productivity software company that builds a single connected
 * workspace for notes, documents, wikis, databases, and project and task
 * management. It also offers Notion AI and Notion Calendar within the same
 * product suite. The company is headquartered in San Francisco.
 *
 * Sector: Productivity & collaboration software. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `notion`
 * (`https://jobs.ashbyhq.com/notion`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'notion';
const COMPANY_NAME = 'Notion';

@SourcePlugin({
  site: Site.NOTION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NotionService implements IScraper {
  private readonly logger = new Logger(NotionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Notion',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Notion: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NOTION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'notion-');
      }
    }

    this.logger.log(`Notion: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
