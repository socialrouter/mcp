# SocialRouter MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the [SocialRouter](https://socialrouter.io) API to LLM agents. Plug it into Claude Desktop, Claude Code, Cursor, or any MCP-compatible client to let the agent extract social media data and run query-driven searches through a single unified API.

Supported platforms include LinkedIn, Instagram, X, Reddit, Facebook, TikTok, YouTube, Pinterest, Bluesky, Snapchat, and Google Maps.

## Configuration

Get an API key at [socialrouter.io](https://socialrouter.io), then add the server to your MCP client config.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "socialrouter": {
      "command": "npx",
      "args": ["-y", "@socialrouter/mcp"],
      "env": {
        "SOCIALROUTER_API_KEY": "sr_live_xxxxxxxxxxxxx"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` with the same shape.

## How it works

The server is a thin, stateless wrapper over the API, built around service
slugs of the form `<provider>/<platform>/<type>` (e.g.
`brightdata/linkedin/profile.info`). The agent discovers what exists with
`list_services`, then calls `extract` (URL-driven) or `search` (query-driven)
with the chosen slug. The MCP does no URL detection and no routing — picking
the right service is the agent's job, and the catalog gives it everything it
needs: platform, type, price per record, and batch cap for every live
service.

Every slug is validated against the live catalog (`GET /v1/providers`)
**before** the request is sent:

- the `service` parameter is an enum of the slugs live at startup, so the
  agent cannot invent an invalid one;
- at call time the slug is re-checked against the refreshed catalog (5-minute
  TTL) and the batch size against the provider's cap;
- validation failures return corrective errors listing the closest valid
  alternatives (same platform/type, other providers) instead of a bare 4xx.

The catalog is fetched once at startup — if it cannot be loaded the server
exits, since an unreachable catalog means the API itself is unreachable — and
refreshed lazily afterwards; if a refresh fails, the last known catalog keeps
being served.

## Tools

| Tool | Description |
|---|---|
| `list_services` | One row per live (provider, platform, type) with price per record and batch cap, cheapest first within each platform/type. Filter by `platform` and/or `type`. |
| `extract` | Extract data from one or more URLs through a service slug. All URLs in a call must belong to the service's platform. |
| `search` | Query-driven search (no URL needed) through a search service slug (type ends in `.search`). |
| `get_extraction` | Retrieve a previous extraction or search by ID. |
| `get_account` | Credit balance + usage summary (by provider and platform) over the last N days. |

### `extract` / `search` parameters

| Param | Tools | Description |
|---|---|---|
| `urls` | `extract` | One or more URLs, all on the service's platform. |
| `queries` | `search` | One or more search terms, or URLs that pin the search context. |
| `service` | both | Required. Service slug `<provider>/<platform>/<type>` from `list_services`. |
| `limit` | both | Optional. Max records to return (default 100). |
| `variant` | both | Optional, advanced. Actor variant of the service, appended to the slug as `:variant`. |
| `fallback` | both | Optional. Retry alternative providers on failure (default `true`). |
| `options` | both | Optional. Actor-specific overrides (e.g. `proxyCountry`). |

### Typical flow

1. `list_services` with `platform: "linkedin"` → see what LinkedIn data is
   available and at what price.
2. `extract` with `urls: ["https://www.linkedin.com/in/..."]` and
   `service: "brightdata/linkedin/profile.info"`.
3. (async results) `get_extraction` with the returned ID.

## Environment Variables

| Variable | Required | Default |
|---|---|---|
| `SOCIALROUTER_API_KEY` | yes | — |
| `SOCIALROUTER_BASE_URL` | no | `https://api.socialrouter.io` |

## License

MIT
