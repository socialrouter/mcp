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

## Tools

| Tool | Description |
|---|---|
| `extract` | URL-driven extraction. Pass `url` (single) or `urls` (batch). |
| `search` | Query-driven search (e.g. Google Maps place search). |
| `list_providers` | List available providers and their supported platforms/types. |
| `get_provider` | Get a single provider's details and pricing. |
| `get_extraction` | Retrieve a previous extraction or search by ID. |
| `get_balance` | Check your SocialRouter credit balance. |
| `get_usage` | Get a usage summary by provider and platform. |

### `extract` parameters

| Param | Required | Description |
|---|---|---|
| `url` | one of `url`/`urls` | Single social media URL. |
| `urls` | one of `url`/`urls` | Batch list of URLs (only effective for batch-capable actors). |
| `provider` | yes | Service slug `provider/platform/type[:tag]` (e.g. `apify/linkedin/profile.info`, `apify/linkedin/profile.posts:apimaestro`). Copy from [socialrouter.io/providers](https://www.socialrouter.io/providers). |
| `limit` | no | Max records (default 100). |
| `fallback` | no | Whether to fall over to alternative providers on failure (default `true`). |

### `search` parameters

| Param | Required | Description |
|---|---|---|
| `queries` | yes | Non-empty list of search queries (terms or context-pinning URLs). |
| `provider` | yes | Slug whose `type` is a search type, e.g. `apify/googlemaps/place.search`. |
| `limit` | no | Per-query record cap (default 100). |
| `fallback` | no | Whether to fall over to alternative providers on failure (default `true`). |

## Environment Variables

| Variable | Required | Default |
|---|---|---|
| `SOCIALROUTER_API_KEY` | yes | — |
| `SOCIALROUTER_BASE_URL` | no | `https://api.socialrouter.io` |

## License

MIT
