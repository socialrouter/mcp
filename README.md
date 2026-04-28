# SocialRouter MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the [SocialRouter](https://socialrouter.io) API to LLM agents. Plug it into Claude Desktop, Claude Code, Cursor, or any MCP-compatible client to let the agent extract social media data (LinkedIn, Instagram, X, Reddit) — likes, comments, profile info, posts, followers — through a single unified API.

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
| `extract` | Extract data from a social media URL. Specify the routing target with a `provider` slug. |
| `list_providers` | List available data extraction providers and their status. |
| `get_balance` | Check your SocialRouter credit balance. |
| `get_extraction` | Retrieve a previous extraction by ID. |

### `extract` parameters

| Param | Required | Description |
|---|---|---|
| `url` | yes | Full URL of the social media content |
| `provider` | yes | Service slug `provider/platform/type` (e.g. `apify/linkedin/profile.info`) — copy from [socialrouter.io/providers](https://www.socialrouter.io/providers) |
| `limit` | no | Max records (default 100) |

## Environment Variables

| Variable | Required | Default |
|---|---|---|
| `SOCIALROUTER_API_KEY` | yes | — |
| `SOCIALROUTER_BASE_URL` | no | `https://api.socialrouter.io` |

## License

MIT
