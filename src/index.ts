interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * India Government Tenders MCP — active public tenders from India's official
 * e-procurement portals (keyless).
 *
 * Sources (all public, no login):
 *   - Ministry of Defence e-Procurement (defproc.gov.in) — Army, Navy, Air Force,
 *     DRDO, Military Engineer Services, Border Roads, Defence Estates, Coast Guard.
 *   - Central Public Procurement Portal, central-government GePNIC instance
 *     (eprocure.gov.in/eprocure) — ministries, departments, autonomous bodies.
 *   - Central PSU e-tenders (etenders.gov.in) — central public-sector enterprises,
 *     including the defence PSUs (AWEIL, Armoured Vehicles Nigam, Munitions India,
 *     Yantra India, India Optel, Troop Comforts, Cochin Shipyard).
 *   - State / sector GePNIC portals (Maharashtra, Tamil Nadu, Kerala, West Bengal,
 *     Rajasthan, Delhi, Coal India, IOCL, PMGSY).
 *   - CPPP "latest active tenders" aggregator (eprocure.gov.in/cppp), including the
 *     Government e-Marketplace (GeM) bids that CPPP lists.
 *
 * How the GePNIC portals are read: every portal runs the same NIC software, whose
 * keyword search is captcha-gated. The captcha-free route is "Tenders by
 * Organisation": the organisation list (with live active-tender counts), then one
 * page per organisation listing all of its active tenders. Those per-organisation
 * links are session-bound (Tapestry `session=T`), so every call opens a fresh
 * session on the organisation list and reuses its cookie for the drill-in.
 * Keyword filtering is done here over the organisation pages fetched.
 *
 * Known source quirk: the Military Engineer Services page lists ~4,000 tenders on
 * ONE page (~8.6 MB, mostly a serialized page-state field) and takes 30-40 s.
 * It gets a longer timeout; if it times out the other organisations still return
 * and the response says which organisation failed.
 *
 * Dates on these portals are India Standard Time and are returned as ISO 8601
 * with a +05:30 offset.
 */


const UA = 'pipeworx-mcp-india-tenders/1.0 (+https://pipeworx.io)';

async function pwFetch(
  url: string,
  upstream: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  // Accept-Language is load-bearing: the GePNIC (Java/Tapestry) portals answer
  // HTTP 500 to `Accept-Language: *`, which is what Node's fetch sends by default.
  // Measured 2026-10-04: curl with that header -> 500, with en-IN -> 200.
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-IN,en;q=0.9',
    ...(init?.headers ?? {}),
  };
  return fetchWithTimeout(url, { ...init, headers }, upstream, timeoutMs);
}

// ── Portal registry ─────────────────────────────────────────────────────────

interface Portal {
  id: string;
  label: string;
  base: string; // up to and including the context path, no trailing slash
}

const PORTALS: Portal[] = [
  { id: 'defence', label: 'Ministry of Defence e-Procurement (defproc.gov.in)', base: 'https://defproc.gov.in/nicgep' },
  { id: 'central', label: 'Central Public Procurement Portal — central government (eprocure.gov.in/eprocure)', base: 'https://eprocure.gov.in/eprocure' },
  { id: 'cpse', label: 'Central PSU e-Tenders (etenders.gov.in)', base: 'https://etenders.gov.in/eprocure' },
  { id: 'maharashtra', label: 'Maharashtra e-Tenders (mahatenders.gov.in)', base: 'https://mahatenders.gov.in/nicgep' },
  { id: 'tamil-nadu', label: 'Tamil Nadu e-Tenders (tntenders.gov.in)', base: 'https://tntenders.gov.in/nicgep' },
  { id: 'kerala', label: 'Kerala e-Tenders (etenders.kerala.gov.in)', base: 'https://etenders.kerala.gov.in/nicgep' },
  { id: 'west-bengal', label: 'West Bengal e-Tenders (wbtenders.gov.in)', base: 'https://wbtenders.gov.in/nicgep' },
  { id: 'rajasthan', label: 'Rajasthan e-Procurement (eproc.rajasthan.gov.in)', base: 'https://eproc.rajasthan.gov.in/nicgep' },
  { id: 'delhi', label: 'Government of NCT of Delhi e-Procurement (govtprocurement.delhi.gov.in)', base: 'https://govtprocurement.delhi.gov.in/nicgep' },
  { id: 'coal-india', label: 'Coal India e-Tenders (coalindiatenders.nic.in)', base: 'https://coalindiatenders.nic.in/nicgep' },
  { id: 'iocl', label: 'Indian Oil Corporation e-Tenders (iocletenders.nic.in)', base: 'https://iocletenders.nic.in/nicgep' },
  { id: 'pmgsy', label: 'PMGSY rural roads e-Tenders (pmgsytenders.gov.in)', base: 'https://pmgsytenders.gov.in/nicgep' },
];
const PORTAL_IDS = PORTALS.map((p) => p.id);

// Defence organisations that publish OUTSIDE defproc.gov.in: defence PSUs on the
// central-PSU portal and MoD bodies that also use the central portal.
const DEFENCE_ORG_RE =
  /defen[cs]e|weapons and equipment|armoured vehicles|munitions india|troop comforts|yantra india|india optel|gliders india|shipyard|bharat electronics|bharat dynamics|hindustan aeronautics|\bbeml\b|mishra dhatu|mazagon|garden reach/i;

const ORG_PAGE_TIMEOUT_MS = 30_000;
const BIG_ORG_PAGE_TIMEOUT_MS = 55_000; // MES — ~8.6 MB single page
const BIG_ORG_THRESHOLD = 1000; // active tenders on one org page
const CONCURRENCY = 4;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// ── Small helpers ──────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** "01-Oct-2026 06:00 PM" (IST) -> "2026-10-01T18:00:00+05:30". Null if unparseable. */
function istToIso(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  let hh = m[4] ? parseInt(m[4], 10) : 0;
  const mm = m[5] ?? '00';
  const ap = m[6]?.toUpperCase();
  if (ap === 'PM' && hh < 12) hh += 12;
  if (ap === 'AM' && hh === 12) hh = 0;
  return `${m[3]}-${mon}-${m[1].padStart(2, '0')}T${String(hh).padStart(2, '0')}:${mm}:00+05:30`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function text(html: string): string {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function clampLimit(v: unknown, def = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

function words(q: unknown): string[] {
  if (typeof q !== 'string') return [];
  return q.toLowerCase().split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

function getPortal(id: unknown): Portal {
  const p = PORTALS.find((x) => x.id === String(id ?? '').toLowerCase().trim());
  if (!p) throw new Error(`Unknown portal "${String(id)}". Valid portals: ${PORTAL_IDS.join(', ')}.`);
  return p;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── GePNIC session + parsing ───────────────────────────────────────────────

interface Org {
  name: string;
  active_tenders: number;
  href: string; // absolute, session-bound
}

interface Session {
  portal: Portal;
  cookie: string;
  orgs: Org[];
  fetched_at: string;
}

function cookiesFrom(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[]; getAll?: (n: string) => string[] };
  let list: string[] = [];
  if (typeof h.getSetCookie === 'function') list = h.getSetCookie();
  else if (typeof h.getAll === 'function') {
    try { list = h.getAll('Set-Cookie'); } catch { list = []; }
  }
  if (list.length === 0) {
    const one = res.headers.get('set-cookie');
    if (one) list = one.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  }
  return list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function absolutize(portal: Portal, href: string): string {
  const h = decodeEntities(href);
  if (/^https?:/i.test(h)) return h;
  const origin = new URL(portal.base).origin;
  return origin + (h.startsWith('/') ? h : '/' + h);
}

function rowsOf(html: string): string[] {
  const start = html.search(/<tr class="(?:even|odd)"/);
  if (start < 0) return [];
  const body = html.slice(start);
  // Rows carry commented-out <td> cells (`<!-- <td>…</td> -->`); drop comments
  // before splitting or every later column shifts by one.
  return (body.match(/<tr class="(?:even|odd)"[^>]*>[\s\S]*?<\/tr>/g) ?? []).map((r) => r.replace(/<!--[\s\S]*?-->/g, ''));
}

function cellsOf(row: string): string[] {
  return row.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
}

async function openSession(portal: Portal, timeoutMs = ORG_PAGE_TIMEOUT_MS): Promise<Session> {
  const url = `${portal.base}/app?page=FrontEndTendersByOrganisation&service=page`;
  const res = await pwFetch(url, portal.label, undefined, timeoutMs);
  if (!res.ok) throw new Error(`${portal.label}: HTTP ${res.status} on the organisation list`);
  const html = await res.text();
  const orgs: Org[] = [];
  for (const row of rowsOf(html)) {
    const c = cellsOf(row);
    if (c.length < 3) continue;
    const href = c[2].match(/href="([^"]+)"/)?.[1];
    const n = parseInt(text(c[2]).replace(/,/g, ''), 10);
    if (!href || !Number.isFinite(n)) continue;
    orgs.push({ name: text(c[1]), active_tenders: n, href: absolutize(portal, href) });
  }
  if (orgs.length === 0) {
    throw new Error(`${portal.label}: the organisation list parsed to zero organisations — the page layout may have changed.`);
  }
  return { portal, cookie: cookiesFrom(res), orgs, fetched_at: new Date().toISOString() };
}

interface Tender {
  tender_id: string | null;
  reference_number: string | null;
  title: string;
  organisation: string;
  organisation_chain: string;
  published_at: string | null;
  bid_submission_closes_at: string | null;
  bid_opening_at: string | null;
  portal: string;
  portal_label: string;
  source_url: string;
}

interface ParsedTender extends Tender {
  _view_href: string | null;
}

function parseTenderRows(html: string, s: Session, orgName: string): ParsedTender[] {
  const out: ParsedTender[] = [];
  for (const row of rowsOf(html)) {
    const c = cellsOf(row);
    if (c.length < 6) continue;
    const titleCell = c[4];
    const a = titleCell.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const title = a ? text(a[2]).replace(/^\[|\]$/g, '').trim() : '';
    const rest = text(a ? titleCell.replace(a[0], '') : titleCell);
    const ids = rest.match(/\[([^\]]*)\]\s*\[([^\]]+)\]\s*$/);
    const chain = text(c[5]);
    out.push({
      tender_id: ids ? ids[2].trim() : null,
      reference_number: ids ? ids[1].trim() || null : null,
      title: title || rest,
      organisation: chain.split('||')[0]?.trim() || orgName,
      organisation_chain: chain.replace(/\|\|/g, ' > '),
      published_at: istToIso(text(c[1])),
      bid_submission_closes_at: istToIso(text(c[2])),
      bid_opening_at: istToIso(text(c[3])),
      portal: s.portal.id,
      portal_label: s.portal.label,
      source_url: `${s.portal.base}/app?page=FrontEndTendersByOrganisation&service=page`,
      _view_href: a ? absolutize(s.portal, a[1]) : null,
    });
  }
  return out;
}

interface OrgScan {
  organisation: string;
  active_tenders_listed: number;
  status: 'ok' | 'error';
  parsed?: number;
  error?: string;
}

async function fetchOrgTenders(s: Session, org: Org): Promise<{ scan: OrgScan; tenders: ParsedTender[] }> {
  const timeout = org.active_tenders >= BIG_ORG_THRESHOLD ? BIG_ORG_PAGE_TIMEOUT_MS : ORG_PAGE_TIMEOUT_MS;
  try {
    const res = await pwFetch(org.href, s.portal.label, { headers: s.cookie ? { Cookie: s.cookie } : {} }, timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const tenders = parseTenderRows(html, s, org.name);
    if (tenders.length === 0 && org.active_tenders > 0) {
      throw new Error(
        /session|expired|stale/i.test(html.slice(0, 5000))
          ? 'the portal reported the session as expired before the organisation page loaded'
          : 'organisation page returned no tender rows although the portal lists active tenders for it',
      );
    }
    return {
      scan: { organisation: org.name, active_tenders_listed: org.active_tenders, status: 'ok', parsed: tenders.length },
      tenders,
    };
  } catch (e) {
    return {
      scan: { organisation: org.name, active_tenders_listed: org.active_tenders, status: 'error', error: e instanceof Error ? e.message : String(e) },
      tenders: [],
    };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every keyword must start a word (so "gen" matches "GEN SET", not "jagadhari"). */
function wordMatcher(ws: string[]): (hay: string) => boolean {
  const res = ws.map((w) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(w)}`, 'i'));
  return (hay) => res.every((r) => r.test(hay));
}

function hayOf(t: Tender): string {
  return `${t.title} ${t.reference_number ?? ''} ${t.tender_id ?? ''} ${t.organisation_chain}`;
}

function matches(t: Tender, ws: string[]): boolean {
  if (ws.length === 0) return true;
  return wordMatcher(ws)(hayOf(t));
}

/** 1 when the whole query appears as a phrase in the title — those rank first. */
function phraseRank(t: Tender, ws: string[]): number {
  if (ws.length < 2) return 0;
  return t.title.toLowerCase().includes(ws.join(' ')) ? 1 : 0;
}

function afterFilter(t: Tender, closingAfter: string | null): boolean {
  if (!closingAfter || !t.bid_submission_closes_at) return true;
  return t.bid_submission_closes_at.slice(0, 10) >= closingAfter;
}

/** Said whenever a keyword filter matched nothing, so a true zero reads as one. */
function zeroHint(matched: number, scannedRows: number, ws: string[]): string | null {
  if (matched > 0 || ws.length === 0) return null;
  return `No active tender matched all of [${ws.join(', ')}] across ${scannedRows} scanned. Titles are terse buyer shorthand (e.g. "GEN SET" not "generator", "PROVN" for provision, "REPAIR/MAINT"); try one shorter keyword.`;
}

function strip(t: ParsedTender): Tender {
  const { _view_href: _ignored, ...rest } = t;
  return rest;
}

function parseDateArg(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${name} must be a date in YYYY-MM-DD form, got "${s}".`);
  return s;
}

/** Scan a set of (session, org) pairs, filter, sort newest-published first. */
async function scan(
  targets: Array<{ s: Session; org: Org }>,
  ws: string[],
  closingAfter: string | null,
): Promise<{ tenders: ParsedTender[]; scanned: Array<OrgScan & { portal: string }> }> {
  const results = await mapLimit(targets, CONCURRENCY, async ({ s, org }) => {
    const r = await fetchOrgTenders(s, org);
    return { ...r, portal: s.portal.id };
  });
  const tenders: ParsedTender[] = [];
  const scanned: Array<OrgScan & { portal: string }> = [];
  for (const r of results) {
    scanned.push({ portal: r.portal, ...r.scan });
    for (const t of r.tenders) if (matches(t, ws) && afterFilter(t, closingAfter)) tenders.push(t);
  }
  tenders.sort((a, b) => phraseRank(b, ws) - phraseRank(a, ws) || (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  return { tenders, scanned };
}

const LARGE_NOTE =
  `Organisations with ${BIG_ORG_THRESHOLD}+ active tenders (on defproc.gov.in that is Military Engineer Services, mostly civil works) publish them all on one multi-megabyte page that takes 30-60 s to load, so they are skipped unless named in organisation or include_large_orgs is true.`;

/** Large single-page organisations are opt-in: named via `organisation`, or include_large_orgs. */
function isLargeSkipped(org: Org, organisationArg: unknown, includeLarge: boolean): boolean {
  if (org.active_tenders < BIG_ORG_THRESHOLD) return false;
  if (includeLarge) return false;
  return !(typeof organisationArg === 'string' && organisationArg.trim().length > 0);
}

function orgFilter(orgs: Org[], needle: unknown): Org[] {
  if (typeof needle !== 'string' || !needle.trim()) return orgs;
  const n = needle.toLowerCase().trim();
  return orgs.filter((o) => o.name.toLowerCase().includes(n));
}

// ── CPPP aggregator ────────────────────────────────────────────────────────

const CPPP_BASE = 'https://eprocure.gov.in/cppp/latestactivetendersnew';

function cpppPageUrl(feed: 'cpppdata' | 'gemdata', page: number): string {
  if (page <= 1) return `${CPPP_BASE}/${feed}`;
  // CPPP's own pager wraps the target URL in base64 under ?url=; the inner
  // page number is the 1-based page shown to users (page=2 -> rows 11-20).
  const inner = `${CPPP_BASE}/${feed}?page=${page}`;
  return `${CPPP_BASE}/${feed}?url=${encodeURIComponent(btoa(inner))}`;
}

interface CpppRow {
  [k: string]: string | null;
}

function parseCppp(html: string, feed: 'cpppdata' | 'gemdata'): { rows: CpppRow[]; last_page: number | null } {
  const tb = html.indexOf('<tbody');
  const body = tb >= 0 ? html.slice(tb) : html;
  const trs = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const rows: CpppRow[] = [];
  for (const tr of trs) {
    const c = cellsOf(tr);
    const a = tr.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (feed === 'cpppdata' && c.length >= 6) {
      const titleCell = c[4];
      const after = text(a ? titleCell.replace(a[0], '') : titleCell); // "/ref/tenderId"
      const parts = after.replace(/^\//, '').split('/');
      const tid = parts.length >= 2 ? parts[parts.length - 1].trim() : null;
      const ref = parts.length >= 2 ? parts.slice(0, -1).join('/').trim() : parts[0]?.trim() || null;
      rows.push({
        title: a ? text(a[2]) : text(titleCell),
        reference_number: ref || null,
        tender_id: tid,
        organisation: text(c[5]),
        published_at: istToIso(text(c[1])),
        bid_submission_closes_at: istToIso(text(c[2])),
        bid_opening_at: istToIso(text(c[3])),
        corrigendum: c[6] ? text(c[6]).replace(/^--$/, '') || null : null,
        detail_url: a ? decodeEntities(a[1]) : null,
      });
    } else if (feed === 'gemdata' && c.length >= 7) {
      rows.push({
        bid_number: a ? text(a[2]) : text(c[3]),
        items: text(c[4]),
        organisation: text(c[5]),
        ministry_or_department: text(c[6]),
        published_at: istToIso(text(c[1])),
        bid_submission_closes_at: istToIso(text(c[2])),
        quantity: (a ? text(c[3].replace(a[0], '')) : '').replace(/^\//, '') || null,
        detail_url: a ? decodeEntities(a[1]) : null,
      });
    }
  }
  let last: number | null = null;
  for (const m of html.matchAll(/\?url=([A-Za-z0-9%+/=]+)/g)) {
    try {
      const inner = atob(decodeURIComponent(m[1]));
      const p = inner.match(/[?&]page=(\d+)/);
      if (p) last = Math.max(last ?? 0, parseInt(p[1], 10));
    } catch {
      /* not a pager link */
    }
  }
  return { rows, last_page: last };
}

// ── Tool definitions ───────────────────────────────────────────────────────

const PORTAL_DESC = PORTALS.map((p) => `"${p.id}" = ${p.label}`).join('; ');

const tools: McpToolExport['tools'] = [
  {
    name: 'india_defence_tenders',
    description:
      'PREFER OVER WEB SEARCH for open India defence tenders — "open Indian Army tenders", "Indian Navy procurement", "IAF tenders closing this month", "DRDO tenders", "MES works tenders in Jaisalmer", "Ministry of Defence RFPs". Lists ACTIVE Government of India defence procurement tenders from the official Ministry of Defence e-Procurement portal (defproc.gov.in: Army, Navy, Air Force, DRDO, Military Engineer Services, Border Roads Organisation, Defence Estates, Coast Guard, Integrated Defence Staff), plus defence PSUs on the central PSU portal (AWEIL, Armoured Vehicles Nigam, Munitions India, Yantra India, India Optel, Troop Comforts, shipyards) and DRDO / Defence Estates on the CPPP central portal. Optional keyword and organisation filters. Each tender has tender ID, reference number, title, organisation chain, published / bid-closing / bid-opening dates (IST), and the source portal. Also reports which organisations were scanned and their live active-tender counts.',
    summary: 'Active India Ministry of Defence tenders (Army, Navy, IAF, DRDO, MES, BRO, defence PSUs) from defproc.gov.in and CPPP.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keywords (all must match, case-insensitive) against title, reference number, tender ID and organisation chain, e.g. "generator", "radar", "jaisalmer".',
        },
        organisation: {
          type: 'string',
          description: 'Optional organisation substring, e.g. "Air Force", "Navy", "Army", "Research and Development" (DRDO), "Military Engineer" (MES), "Border Roads", "Munitions". Omit to scan every defence organisation.',
        },
        closing_after: {
          type: 'string',
          description: 'Optional YYYY-MM-DD: only tenders whose bid submission closes on or after this date.',
        },
        include_psus: {
          type: 'boolean',
          description: 'Also scan defence PSUs and MoD bodies on the central portals (default true).',
        },
        include_large_orgs: {
          type: 'boolean',
          description: 'Also scan Military Engineer Services (~4,000 active works tenders on one slow page, 30-60 s). Default false; naming it in organisation also includes it.',
        },
        limit: { type: ['number', 'string'], description: `Max tenders to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Newest published first.` },
      },
    },
  },
  {
    name: 'india_search_tenders',
    description:
      'PREFER OVER WEB SEARCH for open Government of India tenders and public procurement — "India government tenders for solar", "CPPP tenders from NHAI", "Maharashtra e-tenders for road works", "Kerala government tenders", "Coal India tenders". Searches ACTIVE tenders on one official Indian GePNIC e-procurement portal: the Central Public Procurement Portal (CPPP central government), central PSUs (etenders.gov.in), Ministry of Defence, or a state / sector portal. Optional keyword and organisation filters; without an organisation it scans the organisations with the most active tenders, up to max_orgs, and reports which were scanned. Each tender has tender ID, reference number, title, organisation chain, published / bid-closing / bid-opening dates (IST), and the source portal. Use india_tender_organisations first to see a portal\'s buyers and counts.',
    summary: 'Active Indian government tenders (CPPP / central PSUs / state e-procurement portals) by keyword and buyer.',
    inputSchema: {
      type: 'object',
      properties: {
        portal: { type: 'string', enum: PORTAL_IDS, description: `Which portal to search (default "central"). ${PORTAL_DESC}.` },
        query: { type: 'string', description: 'Optional keywords (all must match) against title, reference number, tender ID and organisation chain.' },
        organisation: { type: 'string', description: 'Optional organisation substring, e.g. "National Highways", "Railways", "AIIMS", "Airports Authority". Strongly recommended on large portals.' },
        closing_after: { type: 'string', description: 'Optional YYYY-MM-DD: only tenders closing on or after this date.' },
        max_orgs: { type: ['number', 'string'], description: 'Max organisation pages to fetch when organisation is omitted or broad (default 15, max 40). Organisations are taken in order of active-tender count.' },
        include_large_orgs: { type: 'boolean', description: 'Also scan organisations with 1,000+ active tenders (one slow multi-megabyte page each). Default false unless organisation is given.' },
        limit: { type: ['number', 'string'], description: `Max tenders to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Newest published first.` },
      },
    },
  },
  {
    name: 'india_tender_organisations',
    description:
      'Lists the buying organisations on an official Indian government e-procurement portal (CPPP central, central PSUs, Ministry of Defence, or a state portal) with each one\'s live count of ACTIVE tenders — "which Indian ministries have open tenders", "how many active tenders does the Indian Army have", "biggest buyers on Maharashtra e-tenders". Use it to pick an organisation for india_search_tenders.',
    summary: 'Buyers on an Indian e-procurement portal with live active-tender counts.',
    inputSchema: {
      type: 'object',
      properties: {
        portal: { type: 'string', enum: PORTAL_IDS, description: `Which portal (default "central"). ${PORTAL_DESC}.` },
        query: { type: 'string', description: 'Optional organisation-name substring filter.' },
      },
    },
  },
  {
    name: 'india_get_tender',
    description:
      'Full details of one Indian government tender by its portal tender ID (e.g. "2026_IAF_792147_1") from the official GePNIC e-procurement portal that published it — tender type and category, form of contract, EMD amount, tender fee, tender value, product category, work description, location and pincode, pre-bid meeting, all key dates (IST), and the organisation chain. Take the tender_id and portal from india_defence_tenders or india_search_tenders; passing the organisation makes the lookup much faster.',
    summary: 'Full detail for one Indian e-procurement tender by tender ID.',
    inputSchema: {
      type: 'object',
      properties: {
        tender_id: { type: 'string', description: 'Portal tender ID, e.g. "2026_IAF_792147_1" (the last bracketed value in a listing).' },
        portal: { type: 'string', enum: PORTAL_IDS, description: `Portal the tender is on (default "defence"). ${PORTAL_DESC}.` },
        organisation: { type: 'string', description: 'Optional organisation substring to narrow the lookup, e.g. "Air Force".' },
      },
      required: ['tender_id'],
    },
  },
  {
    name: 'india_cppp_latest_tenders',
    description:
      'Latest ACTIVE tenders as listed on India\'s Central Public Procurement Portal (CPPP, eprocure.gov.in/cppp) — either the all-portal tender feed ("cppp": central and state e-procurement systems, newest published first) or the Government e-Marketplace bid feed CPPP lists ("gem": GeM bid number, items, buying organisation and ministry, closing date; ordered soonest-closing first). "Latest Indian government tenders", "new GeM bids", "GeM bids from Ministry of Defence". Returns one or more 10-row pages with an optional keyword filter over those pages; CPPP\'s own keyword search is captcha-gated, so for buyer-specific searches use india_search_tenders.',
    summary: 'Newest tenders on India\'s CPPP feed, or GeM (Government e-Marketplace) bids as listed by CPPP.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: { type: 'string', enum: ['cppp', 'gem'], description: '"cppp" = all-portal tender feed (default); "gem" = Government e-Marketplace bids.' },
        page: { type: ['number', 'string'], description: 'First page to fetch (1-based, default 1). 10 rows per page.' },
        pages: { type: ['number', 'string'], description: 'How many consecutive pages to fetch (default 1, max 5).' },
        query: { type: 'string', description: 'Optional keywords (all must match) applied to the fetched rows.' },
      },
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────────

async function defenceTenders(args: Record<string, unknown>) {
  const ws = words(args.query);
  const closingAfter = parseDateArg(args.closing_after, 'closing_after');
  const limit = clampLimit(args.limit);
  const includePsus = args.include_psus === undefined ? true : args.include_psus === true || args.include_psus === 'true';
  const includeLarge = args.include_large_orgs === true || args.include_large_orgs === 'true';

  const portals = [getPortal('defence'), ...(includePsus ? [getPortal('cpse'), getPortal('central')] : [])];
  const sessions = await Promise.all(
    // Secondary portals get a shorter budget: a slow PSU portal should not hold
    // the defence answer hostage.
    portals.map((p) => openSession(p, p.id === 'defence' ? ORG_PAGE_TIMEOUT_MS : 15_000).then((s) => ({ s, err: null as string | null })).catch((e) => ({ s: null, err: `${p.label}: ${e instanceof Error ? e.message : String(e)}` }))),
  );
  const errors = sessions.filter((x) => x.err).map((x) => x.err as string);
  const targets: Array<{ s: Session; org: Org }> = [];
  const largeSkipped: Array<{ portal: string; organisation: string; active_tenders: number }> = [];
  for (const { s } of sessions) {
    if (!s) continue;
    let orgs = s.portal.id === 'defence' ? s.orgs : s.orgs.filter((o) => DEFENCE_ORG_RE.test(o.name));
    orgs = orgFilter(orgs, args.organisation).filter((o) => o.active_tenders > 0);
    for (const org of orgs) {
      if (isLargeSkipped(org, args.organisation, includeLarge)) largeSkipped.push({ portal: s.portal.id, organisation: org.name, active_tenders: org.active_tenders });
      else targets.push({ s, org });
    }
  }
  if (!sessions[0].s) {
    throw new Error(`Ministry of Defence e-Procurement portal unreachable: ${errors[0]}`);
  }
  const { tenders, scanned } = await scan(targets, ws, closingAfter);
  const activeListed = targets.reduce((n, t) => n + t.org.active_tenders, 0);
  return {
    source: 'Ministry of Defence e-Procurement (defproc.gov.in) and Central Public Procurement Portal (eprocure.gov.in, etenders.gov.in)',
    data_as_of: new Date().toISOString(),
    query: args.query ?? null,
    organisation_filter: args.organisation ?? null,
    active_tenders_listed_in_scanned_organisations: activeListed,
    matched: tenders.length,
    returned: Math.min(limit, tenders.length),
    tenders: tenders.slice(0, limit).map(strip),
    ...(zeroHint(tenders.length, scanned.reduce((n, x) => n + (x.parsed ?? 0), 0), ws) ? { zero_match_hint: zeroHint(tenders.length, scanned.reduce((n, x) => n + (x.parsed ?? 0), 0), ws) } : {}),
    organisations_scanned: scanned,
    organisations_not_scanned: largeSkipped.length ? largeSkipped : null,
    ...(errors.length ? { portal_errors: errors } : {}),
    note:
      targets.length === 0
        ? `No defence organisation matched "${String(args.organisation)}". Defence organisations on defproc.gov.in: ${sessions[0].s.orgs.map((o) => o.name).join('; ')}.`
        : 'Active tenders only. Keyword search on these portals is captcha-gated, so filtering is applied over each scanned organisation\'s full active-tender list.' +
          (largeSkipped.length ? ` ${LARGE_NOTE}` : ''),
  };
}

async function searchTenders(args: Record<string, unknown>) {
  const portal = getPortal(args.portal ?? 'central');
  const ws = words(args.query);
  const closingAfter = parseDateArg(args.closing_after, 'closing_after');
  const limit = clampLimit(args.limit);
  const maxOrgs = clampLimit(args.max_orgs, 15, 40);
  const includeLarge = args.include_large_orgs === true || args.include_large_orgs === 'true';
  const s = await openSession(portal);
  const matchedOrgs = orgFilter(s.orgs, args.organisation).filter((o) => o.active_tenders > 0);
  const largeSkipped = matchedOrgs.filter((o) => isLargeSkipped(o, args.organisation, includeLarge));
  const candidates = matchedOrgs
    .filter((o) => !largeSkipped.includes(o))
    .sort((a, b) => b.active_tenders - a.active_tenders);
  const chosen = candidates.slice(0, maxOrgs);
  const skipped = candidates.slice(maxOrgs);
  const { tenders, scanned } = await scan(chosen.map((org) => ({ s, org })), ws, closingAfter);
  return {
    source: portal.label,
    portal: portal.id,
    data_as_of: s.fetched_at,
    query: args.query ?? null,
    organisation_filter: args.organisation ?? null,
    portal_active_tenders: s.orgs.reduce((n, o) => n + o.active_tenders, 0),
    matched: tenders.length,
    returned: Math.min(limit, tenders.length),
    tenders: tenders.slice(0, limit).map(strip),
    ...(zeroHint(tenders.length, scanned.reduce((n, x) => n + (x.parsed ?? 0), 0), ws) ? { zero_match_hint: zeroHint(tenders.length, scanned.reduce((n, x) => n + (x.parsed ?? 0), 0), ws) } : {}),
    organisations_scanned: scanned.map(({ portal: _p, ...r }) => r),
    organisations_not_scanned:
      skipped.length || largeSkipped.length
        ? {
            count: skipped.length + largeSkipped.length,
            active_tenders: [...skipped, ...largeSkipped].reduce((n, o) => n + o.active_tenders, 0),
            names: [...largeSkipped, ...skipped].slice(0, 25).map((o) => `${o.name} (${o.active_tenders})`),
          }
        : null,
    note:
      chosen.length === 0
        ? `No organisation on ${portal.label} matched "${String(args.organisation)}". Call india_tender_organisations for the list.`
        : (skipped.length
            ? `Scanned the ${chosen.length} organisations with the most active tenders; ${skipped.length} more were not scanned. Pass organisation (or raise max_orgs) to reach them.`
            : 'Active tenders only; every matching organisation was scanned.') + (largeSkipped.length ? ` ${LARGE_NOTE}` : ''),
  };
}

async function tenderOrganisations(args: Record<string, unknown>) {
  const portal = getPortal(args.portal ?? 'central');
  const s = await openSession(portal);
  const orgs = orgFilter(s.orgs, args.query).sort((a, b) => b.active_tenders - a.active_tenders);
  return {
    source: portal.label,
    portal: portal.id,
    data_as_of: s.fetched_at,
    organisation_count: orgs.length,
    active_tenders_total: orgs.reduce((n, o) => n + o.active_tenders, 0),
    organisations: orgs.map((o) => ({ name: o.name, active_tenders: o.active_tenders })),
    other_portals: PORTAL_IDS.filter((id) => id !== portal.id),
  };
}

function parseDetail(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<td[^>]*class="td_caption"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class="td_field"[^>]*>([\s\S]*?)<\/td>/g;
  for (const m of html.matchAll(re)) {
    const k = text(m[1]).replace(/\s*₹\s*/g, ' (INR)').replace(/\s+/g, ' ').trim();
    const v = text(m[2]);
    // Document tables reuse the caption/field classes; their header cells
    // ("S.No", "Cover No Cover Type …") are not tender attributes.
    if (!k || k in out || k.length > 60 || v === 'S.No') continue;
    out[k] = v;
  }
  return out;
}

const DATE_KEYS = /date$/i;

async function getTender(args: Record<string, unknown>) {
  const id = String(args.tender_id ?? '').trim();
  if (!id) throw new Error('tender_id is required, e.g. "2026_IAF_792147_1".');
  const portal = getPortal(args.portal ?? 'defence');
  const s = await openSession(portal);
  // The tender ID usually embeds the organisation code ("2026_IAF_..."); try the
  // most likely organisations first, then the rest, smallest pages first.
  let orgs = orgFilter(s.orgs, args.organisation).filter((o) => o.active_tenders > 0);
  const code = id.split('_')[1]?.toLowerCase() ?? '';
  const hint = (o: Org) => {
    const n = o.name.toLowerCase();
    if (code && n.includes(code)) return 0;
    if (code === 'iaf' && n.includes('air force')) return 0;
    if (code === 'mes' && n.includes('military engineer')) return 0;
    if (code === 'army' && n.includes('army')) return 0;
    if (code === 'navy' && n.includes('navy')) return 0;
    if (code === 'drdo' && n.includes('research and development')) return 0;
    return 1;
  };
  orgs = orgs.sort((a, b) => hint(a) - hint(b) || a.active_tenders - b.active_tenders).slice(0, 40);
  const tried: string[] = [];
  for (const org of orgs) {
    tried.push(org.name);
    const { tenders, scan: sc } = await fetchOrgTenders(s, org);
    if (sc.status === 'error' && orgs.length === 1) throw new Error(`${org.name}: ${sc.error}`);
    const hit = tenders.find((t) => t.tender_id === id);
    if (!hit) continue;
    if (!hit._view_href) return { ...strip(hit), data_as_of: s.fetched_at, details: null, note: 'Listing row found but it carries no detail link.' };
    const res = await pwFetch(hit._view_href, portal.label, { headers: s.cookie ? { Cookie: s.cookie } : {} }, ORG_PAGE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`${portal.label}: HTTP ${res.status} on the tender detail page`);
    const raw = parseDetail(await res.text());
    const details: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(raw)) details[k] = DATE_KEYS.test(k) ? istToIso(v) ?? v : v;
    if (Object.keys(details).length === 0) throw new Error(`${portal.label}: tender detail page parsed to zero fields — the session may have expired.`);
    return { ...strip(hit), data_as_of: s.fetched_at, details };
  }
  throw new Error(
    `Tender "${id}" is not among the ACTIVE tenders of ${tried.length} organisation(s) searched on ${portal.label}` +
      (tried.length ? ` (${tried.slice(0, 8).join('; ')}${tried.length > 8 ? '; …' : ''})` : '') +
      '. It may have closed, be on a different portal, or belong to another organisation — pass portal and organisation.',
  );
}

async function cpppLatest(args: Record<string, unknown>) {
  const feedArg = String(args.feed ?? 'cppp').toLowerCase();
  if (feedArg !== 'cppp' && feedArg !== 'gem') throw new Error('feed must be "cppp" or "gem".');
  const feed = feedArg === 'gem' ? 'gemdata' : 'cpppdata';
  const first = clampLimit(args.page, 1, 100000);
  const pages = clampLimit(args.pages, 1, 5);
  const ws = words(args.query);
  const nums = Array.from({ length: pages }, (_, i) => first + i);
  const results = await mapLimit(nums, 2, async (p) => {
    const res = await pwFetch(cpppPageUrl(feed, p), 'Central Public Procurement Portal', undefined, 40_000);
    if (!res.ok) throw new Error(`Central Public Procurement Portal: HTTP ${res.status} on page ${p}`);
    return parseCppp(await res.text(), feed);
  });
  const all = results.flatMap((r) => r.rows);
  if (all.length === 0) throw new Error(`Central Public Procurement Portal returned no rows for page ${first} — the page may be past the end or the layout changed.`);
  const filtered = ws.length
    ? all.filter((r) => wordMatcher(ws)(Object.values(r).join(' ')))
    : all;
  const lastPage = results.reduce<number | null>((m, r) => (r.last_page && (!m || r.last_page > m) ? r.last_page : m), null);
  return {
    source: feed === 'gemdata' ? 'Central Public Procurement Portal — GeM (Government e-Marketplace) bids' : 'Central Public Procurement Portal — latest active tenders (all portals)',
    source_url: `${CPPP_BASE}/${feed}`,
    data_as_of: new Date().toISOString(),
    pages_fetched: nums,
    total_pages: lastPage,
    approx_total_active: lastPage ? lastPage * 10 : null,
    rows_fetched: all.length,
    matched: filtered.length,
    query: args.query ?? null,
    [feed === 'gemdata' ? 'bids' : 'tenders']: filtered,
    note: 'CPPP\'s keyword search is captcha-gated, so query filters only the pages fetched here.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'india_defence_tenders':
      return defenceTenders(args);
    case 'india_search_tenders':
      return searchTenders(args);
    case 'india_tender_organisations':
      return tenderOrganisations(args);
    case 'india_get_tender':
      return getTender(args);
    case 'india_cppp_latest_tenders':
      return cpppLatest(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
