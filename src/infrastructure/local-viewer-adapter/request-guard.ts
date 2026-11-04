/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Who may call the local viewer. It listens on the developer's machine, and
// any page open in their browser can send it a request: binding to
// localhost does not stop a page on another site. So the viewer answers its
// own page, the developer's tools (curl, scripts), the origins they named,
// and Playwright's trace viewer for the files it reads; it refuses every
// other site before the route runs. CORS alone would not do: it hides the
// answer, not the request, and a plain-text POST is sent without a preflight.

/** Opens the trace of a test, fetched from this viewer, on the "open in Playwright" link. */
export const PLAYWRIGHT_TRACE_VIEWER_ORIGIN = 'https://trace.playwright.dev';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface GuardRequest {
  method: string;
  pathname: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
}

export interface GuardOptions {
  /** The hostname the server is bound to, when not one of the loopback names. */
  hostname?: string;
  /** Origins of other frontends that may call the API (e.g. a dev server with `--api-only`). */
  allowedOrigins?: readonly string[];
}

export type GuardDecision =
  | { allowed: true; corsOrigin: string | null; privateNetwork: boolean }
  | { allowed: false; reason: string };

const hostnameOf = (host: string): string => {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');

    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');

  return colon === -1 ? host : host.slice(0, colon);
};

/** A route that only reads a file of a trace: what Playwright's viewer fetches. */
const isTraceRead = (method: string, pathname: string): boolean =>
  method === 'GET' && pathname.startsWith('/api/executions/') && !pathname.endsWith('/analyze');

export const decideRequest = (request: GuardRequest, options: GuardOptions = {}): GuardDecision => {
  // A name that points at this machine but is not one of ours is a page
  // that rebound its own domain to 127.0.0.1: its calls look same-origin.
  if (!request.host) {
    return { allowed: false, reason: 'Host header missing' };
  }
  const hostname = hostnameOf(request.host).toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname) && hostname !== options.hostname?.toLowerCase()) {
    return { allowed: false, reason: `Host ${request.host} is not this viewer` };
  }

  // The page itself and its files: following a link to the viewer works.
  if (!request.pathname.startsWith('/api/')) {
    return { allowed: true, corsOrigin: null, privateNetwork: false };
  }

  const selfOrigin = `http://${request.host}`;
  const { origin } = request;
  if (origin !== undefined) {
    if (origin === selfOrigin || (options.allowedOrigins ?? []).includes(origin)) {
      return { allowed: true, corsOrigin: origin, privateNetwork: false };
    }
    if (
      origin === PLAYWRIGHT_TRACE_VIEWER_ORIGIN &&
      (isTraceRead(request.method, request.pathname) || request.method === 'OPTIONS')
    ) {
      return { allowed: true, corsOrigin: origin, privateNetwork: true };
    }

    return { allowed: false, reason: `Origin ${origin} may not call the viewer API` };
  }

  // No Origin: the viewer's own GETs, a typed URL, or a tool that is not a
  // browser (no Sec-Fetch-Site either). Another site's <img> or <script>
  // says cross-site.
  const site = request.secFetchSite;
  if (site === undefined || site === 'same-origin' || site === 'none') {
    return { allowed: true, corsOrigin: null, privateNetwork: false };
  }

  return { allowed: false, reason: `A ${site} request may not call the viewer API` };
};

/**
 * The `heal` commands the viewer's page runs: who is logged in, the quota,
 * and logging in with a return to the viewer itself (`selfOrigin`, as
 * `http://<host>`). Nothing else is started.
 */
export const isAllowedHealCommand = (args: readonly string[], selfOrigin: string): boolean => {
  if (args.length === 2 && args[1] === '--json') {
    return args[0] === 'whoami' || args[0] === 'quota';
  }
  if (
    args.length === 4 &&
    args[0] === 'login' &&
    args[1] === '--json' &&
    args[2] === '--return-to'
  ) {
    const returnTo = args[3];

    return returnTo === selfOrigin || returnTo.startsWith(`${selfOrigin}/`);
  }

  return false;
};
