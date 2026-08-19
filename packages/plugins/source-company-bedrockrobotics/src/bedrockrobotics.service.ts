import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Bedrock Robotics — Builds autonomous systems for heavy construction machinery.
 *
 * Bedrock Robotics develops autonomous systems that retrofit onto heavy
 * construction machinery to operate equipment on job sites. The company
 * focuses on autonomy for large infrastructure and construction projects. It
 * has raised significant venture funding.
 *
 * Sector: Autonomy / Construction. HQ: USA.
 *
 * Source: Ashby job board, company slug `bedrock-robotics`
 * (`https://jobs.ashbyhq.com/bedrock-robotics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'bedrock-robotics';
const COMPANY_NAME = 'Bedrock Robotics';

@SourcePlugin({
  site: Site.BEDROCK_ROBOTICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BedrockRoboticsService implements IScraper {
  private readonly logger = new Logger(BedrockRoboticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Bedrock Robotics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Bedrock Robotics: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BEDROCK_ROBOTICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'bedrockrobotics-');
      }
    }

    this.logger.log(`Bedrock Robotics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
