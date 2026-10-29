# @pipeworx/india-tenders

Active Government of India tenders from the official e-procurement portals: the Ministry of Defence portal (defproc.gov.in), the Central Public Procurement Portal (CPPP, including the GeM bids it lists), central PSU e-tenders, and nine state and sector GePNIC portals.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `india_defence_tenders({query?, organisation?, closing_after?, include_psus?, include_large_orgs?, limit?})` — active India defence tenders: Army, Navy, Air Force, DRDO, Border Roads, Defence Estates, Coast Guard, Integrated Defence Staff (defproc.gov.in), plus defence PSUs (AWEIL, Armoured Vehicles Nigam, Munitions India, Yantra India, India Optel, Troop Comforts, shipyards) and DRDO / Defence Estates on the CPPP central portal. Answers "open India defence tenders".
- `india_search_tenders({portal?, query?, organisation?, closing_after?, max_orgs?, include_large_orgs?, limit?})` — active tenders on one portal: `central` (CPPP central government), `cpse`, `defence`, `maharashtra`, `tamil-nadu`, `kerala`, `west-bengal`, `rajasthan`, `delhi`, `coal-india`, `iocl`, `pmgsy`.
- `india_tender_organisations({portal?, query?})` — a portal's buying organisations with their live active-tender counts.
- `india_get_tender({tender_id, portal?, organisation?})` — full detail for one tender: type, category, EMD, fee, value, location, pincode, every key date.
- `india_cppp_latest_tenders({feed?, page?, pages?, query?})` — newest tenders on the CPPP all-portal feed (`cppp`), or GeM bids as listed by CPPP (`gem`).

Every response carries `data_as_of`. Dates are India Standard Time, returned as ISO 8601 with `+05:30`.

## Auth

Keyless. All sources are public pages that need no account.

## Data sources

- <https://defproc.gov.in/nicgep/app?page=FrontEndTendersByOrganisation&service=page> — Ministry of Defence e-Procurement.
- <https://eprocure.gov.in/eprocure/app?page=FrontEndTendersByOrganisation&service=page> — CPPP, central government.
- <https://etenders.gov.in/eprocure/app?page=FrontEndTendersByOrganisation&service=page> — central PSUs.
- `mahatenders.gov.in`, `tntenders.gov.in`, `etenders.kerala.gov.in`, `wbtenders.gov.in`, `eproc.rajasthan.gov.in`, `govtprocurement.delhi.gov.in`, `coalindiatenders.nic.in`, `iocletenders.nic.in`, `pmgsytenders.gov.in` — the same NIC GePNIC software, read the same way.
- <https://eprocure.gov.in/cppp/latestactivetendersnew/cpppdata> and `/gemdata` — the CPPP latest-tenders and GeM feeds.

Things the next person would otherwise rediscover:

- **`Accept-Language: *` returns HTTP 500 on every GePNIC portal.** Node's `fetch` sends that header by default, so a laptop smoke test fails while curl works. The pack sends `en-IN`.
- **Keyword search is captcha-gated** on GePNIC (`FrontEndAdvancedSearch`, `FrontEndLatestActiveTenders`) and on CPPP. The captcha-free route is "Tenders by Organisation": the organisation list, then one page per organisation with all its active tenders. The pack filters keywords over those pages.
- **The per-organisation links are session-bound** (`session=T`). Without the `JSESSIONID` cookie from the organisation-list response they return a 1.4 KB stale-session page. Every call opens its own session.
- **Rows contain a commented-out `<td>`.** Strip HTML comments before splitting cells, or every column after the title shifts by one.
- **Military Engineer Services lists about 4,000 tenders on one 8.6 MB page** (mostly a serialized page-state field) and takes 30 to 60 seconds. Organisations with 1,000 or more active tenders are opt-in: name them in `organisation` or pass `include_large_orgs: true`.
- **`etenders.gov.in` is intermittently slow** (3 s on one request, a 30 s timeout on the next). The defence tool gives the secondary portals a 15 s budget and reports `portal_errors` rather than failing.
- **GeM itself (`bidplus.gem.gov.in`) and `mod.gov.in` refused connections from outside India** in testing on 2026-10-04. GeM coverage comes from the CPPP `gemdata` feed instead.
- **CPPP pagination** wraps the target URL in base64 under `?url=`; the inner `page=N` is the 1-based page shown to users. A bare `?page=N` is ignored and returns page 1.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "india-tenders": {
      "url": "https://gateway.pipeworx.io/india-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/india-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/india_defence_tenders \
  -H 'Content-Type: application/json' \
  -d '{"query":"gen set","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/india_defence_tenders`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-india-tenders` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/india-tenders/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "india-tenders": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-india-tenders"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about India Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
