# Pinterest MCP Server

An MCP (Model Context Protocol) server that lets Claude interact with Pinterest — managing boards, pins, sections, and user profiles via the Pinterest API v5.

## Tech Stack

- **Language:** TypeScript (ES2022, Node16 modules)
- **Runtime:** Node.js >= 20
- **Framework:** `@modelcontextprotocol/sdk` for MCP server
- **Validation:** Zod for tool input schemas
- **Auth:** Pinterest OAuth 2.0 (with refresh) or direct access token
- **Transport:** STDIO

## Project Structure

```
src/
  index.ts          # Entry point — env validation, server setup, STDIO transport
  auth.ts           # OAuth 2.0 flow, token storage (~/.mcp-credentials/), refresh logic
  api.ts            # Typed HTTP client wrapping Pinterest API v5 endpoints
  types.ts          # All TypeScript interfaces (Pin, Board, OAuth tokens, etc.)
  tools/
    auth.ts         # pinterest_auth, pinterest_auth_status tools
    boards.ts       # list_boards, create_board, list_board_sections, create_board_section
    pins.ts         # list_pins, get_pin, get_pin_image, update_pin, move_pin, create_pin
    search.ts       # search_pins, get_user_profile
```

## Build & Run

```bash
npm run build      # tsc → build/
npm run dev        # tsc --watch
npm start          # node build/index.js
```

## Authentication

Two modes (checked at startup in `src/index.ts`):

1. **Direct token:** Set `PINTEREST_ACCESS_TOKEN` env var (read-only scopes assumed)
2. **OAuth:** Set `PINTEREST_APP_ID` + `PINTEREST_APP_SECRET` env vars (full access, browser-based flow on port 3333)

OAuth tokens are stored in `~/.mcp-credentials/pinterest-tokens.json` with `0o600` permissions.

## Conventions

- Each tool group is registered via a `register*Tools(server)` function
- All tool handlers follow try/catch with `isError: true` on failure
- API responses use the `PaginatedResponse<T>` pattern with bookmark-based pagination
- The `api.ts` module handles auth headers and error parsing centrally
- Image fetching (`fetchImageAsBase64`) returns base64 for MCP image content blocks
