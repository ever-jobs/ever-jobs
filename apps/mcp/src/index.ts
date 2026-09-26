#!/usr/bin/env node
/**
 * Ever Jobs MCP Server
 *
 * Model Context Protocol server that allows AI assistants (ChatGPT, Claude,
 * Copilot, etc.) to search for jobs across 166+ sources via the Ever Jobs API.
 *
 * Transport: stdio (standard input/output)
 * Protocol: MCP v1.0
 *
 * Tools:
 *   - search_jobs: Search for jobs across all sources
 *   - get_job_details: Get detailed information about a specific job
 *   - list_sources: List all available job sources
 *   - search_remote_jobs: Convenience tool for remote job search
 *   - get_salary_insights: Salary analysis for a given role
 *   - compare_sources: Compare available source types
 *
 * Usage:
 *   npx @ever-jobs/mcp                      # stdio mode
 *   EVER_JOBS_API_URL=http://localhost:3001  # custom API endpoint
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { searchJobs, getJobDetails, listSources, searchRemoteJobs, getSalaryInsights, compareSources, JobSearchParams, CRAWL_POLICY_INPUT_SCHEMA, normalizeMcpCrawl } from './tools';

const SERVER_NAME = 'ever-jobs';
const SERVER_VERSION = '0.1.0';

/** Create and configure the MCP server */
function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  // ── Tool Listing ─────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_jobs',
        description:
          'Search for jobs across 166+ sources including LinkedIn, Indeed, Glassdoor, ' +
          'Google Careers, Meta, Netflix, Stripe, OpenAI, IBM, Boeing, Zoom, BuiltIn, ' +
          'HeadHunter (Russia/CIS), Djinni (Ukraine), Habr Career, MyCareersFuture (Singapore), ' +
          'Duunitori (Finland), Jobs.ch (Switzerland), Jobs in Japan, ' +
          'Guardian Jobs (UK), AndroidJobs, iOS Dev Jobs, ' +
          'DevOpsJobs, Functional Works, PowerToFly, Clojure Jobs, EcoJobs, ' +
          'TechCareers, JobsDB (Asia-Pacific), Sercanto (Europe), ' +
          'remote job boards, and 28+ ATS platforms (Greenhouse, Lever, Workday, Manatal, ' +
          'Phenom, Bullhorn, Deel, etc.). Returns titles, companies, locations, and descriptions.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Job search query (e.g. "senior software engineer", "data scientist")',
            },
            location: {
              type: 'string',
              description: 'Location filter (e.g. "San Francisco", "Remote", "London")',
            },
            locations: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 10,
              description:
                'Several locations searched in one call (e.g. ["New York, NY", "Chicago, IL"]). Each source is ' +
                'searched once per location and same-source duplicates are removed. Use instead of repeated ' +
                'search_jobs calls; `location`, when also set, is searched first.',
            },
            source: {
              type: 'string',
              description:
                'Specific source to search (e.g. "linkedin", "indeed", "google_careers"). ' +
                'Use list_sources to see all available sources. Omit to search all sources.',
            },
            company: {
              type: 'string',
              description:
                'Company slug for ATS/company-specific sources (e.g. "stripe", "openai"). ' +
                'Required for ATS sources like ashby, greenhouse, lever.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 20, max: 100)',
            },
            remote_only: {
              type: 'boolean',
              description: 'If true, filter to remote-friendly positions only',
            },
            exclude_title_terms: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 50,
              description:
                'Drop jobs whose TITLE contains any of these words or phrases (e.g. ["senior", "lead*", "principal"]). ' +
                'Literal words, NOT regex: whole-word, case- and accent-insensitive, a trailing * matches a prefix, ' +
                'and negated mentions ("no clearance required") are ignored.',
            },
            exclude_keywords: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 50,
              description:
                'Drop jobs whose TITLE or DESCRIPTION contains any of these words or phrases ' +
                '(e.g. ["security clearance", "ts/sci", "polygraph"]). Literal words, NOT regex; same rules as ' +
                'exclude_title_terms.',
            },
            exclude_presets: {
              type: 'array',
              items: { type: 'string', enum: ['security_clearance'] },
              description:
                'Curated exclusion lists matched against title + description. security_clearance drops roles ' +
                'that require (or ask the candidate to obtain) a security clearance or vetting.',
            },
            crawl: CRAWL_POLICY_INPUT_SCHEMA,
          },
          required: ['query'],
        },
      },
      {
        name: 'get_job_details',
        description:
          'Get detailed information about a specific job posting by its URL. ' +
          'Returns the full job description, requirements, salary info, and application link.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            job_url: {
              type: 'string',
              description: 'The full URL of the job posting to get details for',
            },
            job_id: {
              type: 'string',
              description: 'The Ever Jobs internal job ID (returned from search_jobs)',
            },
          },
          required: [],
        },
      },
      {
        name: 'list_sources',
        description:
          'List all available job sources that can be searched. Returns source names, ' +
          'types (job board, ATS, company-specific, remote board), and whether they ' +
          'require a company slug.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            type: {
              type: 'string',
              enum: ['all', 'job_board', 'ats', 'company', 'remote', 'aggregator'],
              description: 'Filter sources by type (default: "all")',
            },
          },
        },
      },
      {
        name: 'search_remote_jobs',
        description:
          'Search specifically for remote jobs across remote-first job boards ' +
          '(RemoteOK, Remotive, We Work Remotely, Jobicy, Himalayas, Arbeitnow). ' +
          'Automatically filters for remote positions only.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Job search query (e.g. "backend engineer", "product designer")',
            },
            source: {
              type: 'string',
              description: 'Specific remote job board (e.g. "remoteok", "weworkremotely")',
            },
            limit: {
              type: 'number',
              description: 'Maximum results (default: 25)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_salary_insights',
        description:
          'Get salary insights and market data for a specific job title or role. ' +
          'Returns min/max/median salary, percentiles, and sample jobs with salary data.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: {
              type: 'string',
              description: 'Job title to analyze (e.g. "senior software engineer", "data scientist")',
            },
            location: {
              type: 'string',
              description: 'Location for salary data (e.g. "San Francisco", "New York")',
            },
            limit: {
              type: 'number',
              description: 'Number of jobs to sample for salary data (default: 50)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'compare_sources',
        description:
          'Compare and analyze all available job sources. Shows total count, ' +
          'breakdown by type, and which sources require a company slug for ATS searches.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
    ],
  }));

  // ── Tool Execution ───────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_jobs': {
          const params: JobSearchParams = {
            query: (args as any)?.query ?? '',
            location: (args as any)?.location,
            locations: (args as any)?.locations,
            source: (args as any)?.source,
            company: (args as any)?.company,
            limit: (args as any)?.limit ?? 20,
            remoteOnly: (args as any)?.remote_only ?? false,
            excludeTitleTerms: (args as any)?.exclude_title_terms,
            excludeKeywords: (args as any)?.exclude_keywords,
            excludePresets: (args as any)?.exclude_presets,
            crawl: normalizeMcpCrawl((args as any)?.crawl),
          };
          const result = await searchJobs(params);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'get_job_details': {
          const jobUrl = (args as any)?.job_url;
          const jobId = (args as any)?.job_id;
          const result = await getJobDetails({ jobUrl, jobId });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'list_sources': {
          const type = (args as any)?.type ?? 'all';
          const result = listSources(type);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'search_remote_jobs': {
          const result = await searchRemoteJobs({
            query: (args as any)?.query ?? '',
            source: (args as any)?.source,
            limit: (args as any)?.limit,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'get_salary_insights': {
          const result = await getSalaryInsights({
            query: (args as any)?.query ?? '',
            location: (args as any)?.location,
            limit: (args as any)?.limit,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'compare_sources': {
          const result = compareSources();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ── Resources ────────────────────────────────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'everjobs://sources',
        name: 'Available Job Sources',
        description: 'List of all 163+ job sources available for searching',
        mimeType: 'application/json',
      },
      {
        uri: 'everjobs://guide',
        name: 'Search Guide',
        description: 'Tips and best practices for effective job searching',
        mimeType: 'text/plain',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    switch (uri) {
      case 'everjobs://sources':
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(listSources('all'), null, 2),
            },
          ],
        };

      case 'everjobs://guide':
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: SEARCH_GUIDE,
            },
          ],
        };

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  });

  return server;
}

const SEARCH_GUIDE = `# Ever Jobs Search Guide

## Basic Search
Use the search_jobs tool with a query:
  search_jobs(query: "software engineer")

## Location Filtering
Add a location to narrow results:
  search_jobs(query: "data scientist", location: "San Francisco")
  search_jobs(query: "product manager", location: "Remote")

Search several places in one call (each source runs once per location):
  search_jobs(query: "backend engineer", locations: ["New York, NY", "Chicago, IL", "Austin, TX"])

## Excluding Jobs
Drop jobs by title words (literal words, not regex; "lead*" matches a prefix):
  search_jobs(query: "software engineer", exclude_title_terms: ["senior", "lead*", "principal"])
Drop jobs that mention something anywhere in the posting:
  search_jobs(query: "engineer", exclude_keywords: ["polygraph", "ts/sci"])
Drop roles that require a security clearance:
  search_jobs(query: "engineer", exclude_presets: ["security_clearance"])

## Specific Sources
Search a specific job board:
  search_jobs(query: "devops", source: "linkedin")
  search_jobs(query: "designer", source: "wellfound")

## Company-Specific (ATS)
Search a company's job board via their ATS:
  search_jobs(query: "engineer", source: "greenhouse", company: "stripe")
  search_jobs(query: "researcher", source: "ashby", company: "openai")

## Company Career Pages
Search a specific company's career page:
  search_jobs(query: "engineer", source: "google_careers")
  search_jobs(query: "ml engineer", source: "meta")
  search_jobs(query: "security", source: "netflix")

## Remote Jobs
Filter for remote positions:
  search_jobs(query: "frontend developer", remote_only: true)

## Source Types
- **Job Boards**: linkedin, indeed, glassdoor, ziprecruiter, dice, monster, builtin, snagajob, dribbble, themuse, startupjobs, fourdayweek, web3career, echojobs, jobstreet, careeronestop, arbeitsagentur, hackernews, landingjobs, authenticjobs, cryptojobslist, higheredjobs, fossjobs, larajobs, pythonjobs, drupaljobs, golangjobs, wordpressjobs, infojobs, jobtechdev, francetravail, navjobs, jobsacuk, jobindex, getonboard, freelancercom, joinrise, canadajobbank, reliefweb, undpjobs, devitjobs, pyjobs, vuejobs, conservationjobs, coroflot, berlinstartupjobs, railsjobs, elixirjobs, crunchboard, cryptocurrencyjobs, hasjob, icrunchdata, swissdevjobs, germantechjobs, nofluffjobs, greenjobsboard, eurojobs, opensourcedesignjobs, academiccareers, djinni, headhunter, habrcareer, mycareersfuture, duunitori, jobsinjapan, jobsch, guardianjobs, androidjobs, iosdevjobs, devopsjobs, functionalworks, powertofly, clojurejobs, ecojobs, techcareers, jobsdb, sercanto
- **Remote Boards**: remoteok, remotive, weworkremotely, jobicy, himalayas, arbeitnow, workingnomads, nodesk, jobspresso, realworkfromanywhere, virtualvocations, remotefirstjobs
- **ATS Platforms**: greenhouse, lever, ashby, workable, workday, manatal, paylocity, bullhorn, phenom, deel, fountain, loxo, breezyhr, comeet, pinpoint, jobylon, homerun, jobscore, talentlyft, crelate, ismartrecruit, recruiterflow, and more
- **API Aggregators**: adzuna, reed, jooble, careerjet, usajobs, findwork, jobdataapi, talroo
- **Company Pages**: google_careers, meta, netflix, stripe, openai, amazon, apple, microsoft, ibm, boeing, zoom

## Salary Research
Use get_salary_insights to research compensation:
  get_salary_insights(query: "senior backend engineer", location: "San Francisco")

## Remote Job Search
Use search_remote_jobs for dedicated remote search:
  search_remote_jobs(query: "full stack developer")

## Source Comparison
Use compare_sources to see all available sources grouped by type.

## Tips
1. Start broad, then narrow with location or source filters
2. Use company-specific sources for the best results at specific companies
3. Remote boards are great for finding distributed work
4. ATS sources require a company slug — use the company's URL subdomain
`;

// ── Main ─────────────────────────────────────────────────────────────
/**
 * Streamable-HTTP mode (MCP_TRANSPORT=http) — serves the MCP over HTTP so it can run as a
 * network service (e.g. an internal k8s deployment). Stateless: a fresh Server + transport per
 * request, which scales horizontally and needs no session store. Stdio stays the default for
 * CLI/desktop use.
 */
async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', transport: 'http', server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post('/mcp', async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP HTTP request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  // Stateless server: no long-lived SSE stream / session to GET or DELETE.
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  const port = Number(process.env.PORT ?? 3002);
  app.listen(port, () => {
    console.error(`Ever Jobs MCP Server v${SERVER_VERSION} started (HTTP/streamable mode) on :${port}`);
  });
}

async function main(): Promise<void> {
  if (process.env.MCP_TRANSPORT === 'http') {
    await startHttp();
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Ever Jobs MCP Server v${SERVER_VERSION} started (stdio mode)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
