import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CodeRabbit — AI-powered code review platform for pull requests.
 *
 * CodeRabbit provides an AI-driven code-review tool that reviews pull
 * requests and provides line-by-line feedback, summaries, and suggestions
 * within developer workflows. It integrates with common source-control
 * platforms. The company is headquartered in the San Francisco area.
 *
 * Sector: B2B SaaS / developer tools. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `coderabbit`
 * (`https://jobs.ashbyhq.com/coderabbit`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'coderabbit';
const COMPANY_NAME = 'CodeRabbit';

@SourcePlugin({
  site: Site.CODERABBIT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CodeRabbitService implements IScraper {
  private readonly logger = new Logger(CodeRabbitService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape CodeRabbit',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `CodeRabbit: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CODERABBIT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'coderabbit-');
      }
    }

    this.logger.log(`CodeRabbit: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
