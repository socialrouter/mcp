# SocialRouter MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the [SocialRouter](https://socialrouter.io) API to LLM agents. Plug it into Claude Desktop, Claude Code, Cursor, or any MCP-compatible client to let the agent fetch social media data through a single unified API.

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

The server is a thin, stateless wrapper over the API, built around **services**
of the form `<platform>/<service>` (e.g. `linkedin/profile.info`,
`reddit/subreddit.posts`). The agent discovers what exists with
`list_services`, then calls `run` with the chosen service and its inputs. The
MCP does no URL detection and no routing — picking the right service is the
agent's job, and the catalog gives it everything it needs: the input kind
(URLs or free-text queries), the accepted URL shapes with concrete examples,
the typed options, and the offers behind the service with their price and
batch cap.

Which **offer** serves a run (`apify/harshmaur`, `brightdata/reddit`…) is the
router's call: it walks the failover chain, cheapest first, and the response's
`served_by` says which one answered. An agent can pin one with `provider`, but
pinning disables failover — omitting it is the better default.

Every call is validated against the live catalog (`GET /v1/services`)
**before** the request is sent:

- the `service` parameter is an enum of the services live at startup, so the
  agent cannot invent one;
- at call time the service is re-checked against the refreshed catalog
  (5-minute TTL), the batch size against the relevant cap (the pinned offer's,
  or the largest in the chain), and a pinned offer against the ones that
  actually serve that service;
- validation failures return corrective errors listing the valid alternatives
  instead of a bare 4xx.

The catalog is fetched once at startup — if it cannot be loaded the server
exits, since an unreachable catalog means the API itself is unreachable — and
refreshed lazily afterwards; if a refresh fails, the last known catalog keeps
being served.

## Tools

| Tool | Description |
|---|---|
| `list_services` | One row per live `<platform>/<service>`: input kind, accepted input shapes with examples, typed options, and the offers behind it (failover order, price per record, batch cap). Filter by `platform` and/or `service`. |
| `run` | Run a service over one or more inputs (URLs or queries, per the service's input kind). |
| `get_extraction` | Retrieve a past run by ID. |
| `get_account` | Credit balance + usage summary (by offer and platform) over the last N days. |

### `run` parameters

| Param | Description |
|---|---|
| `service` | Required. `<platform>/<service>` slug from `list_services`, e.g. `reddit/subreddit.posts`. |
| `inputs` | Required. URLs (url-kind services) or search queries (query-kind services), all for the service's platform. |
| `provider` | Optional, advanced. Pin one offer, e.g. `apify/harshmaur`. Disables failover. |
| `limit` | Optional. Max records to return (default 100, max 250). |
| `options` | Optional. Typed options declared by the service (see `options` in `list_services`). Unknown keys are rejected with a corrective error. |

### Typical flow

1. `list_services` with `platform: "linkedin"` → see what LinkedIn data is
   available, in what shape, and at what price.
2. `run` with `service: "linkedin/profile.info"` and
   `inputs: ["https://www.linkedin.com/in/..."]`.
3. Read `served_by` in the result to know which offer answered.

## Environment Variables

| Variable | Required | Default |
|---|---|---|
| `SOCIALROUTER_API_KEY` | yes | — |
| `SOCIALROUTER_BASE_URL` | no | `https://api.socialrouter.io` |

## License

MIT
