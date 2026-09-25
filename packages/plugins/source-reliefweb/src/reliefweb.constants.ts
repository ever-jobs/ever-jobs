export const RELIEFWEB_API_URL = 'https://api.reliefweb.int/v1/jobs';
export const RELIEFWEB_APP_NAME = 'ever-jobs';
export const RELIEFWEB_DEFAULT_RESULTS = 25;
export const RELIEFWEB_MAX_RESULTS = 100;

export const RELIEFWEB_HEADERS: Record<string, string> = {
  'Accept': 'application/json',
  'User-Agent': 'ever-jobs/0.1.0 (job-aggregator)',
};

export const RELIEFWEB_FIELDS = [
  'title', 'body', 'url', 'source', 'date', 'country', 'theme', 'type',
];

/**
 * Public page of a ReliefWeb job by node id (Spec 1751). Used only when the
 * API omits `fields.url`; each entry's `href` is its API resource
 * (`https://api.reliefweb.int/v1/jobs/<id>`) and must never become a link.
 */
export const RELIEFWEB_PUBLIC_NODE_URL = 'https://reliefweb.int/node';
