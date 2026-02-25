# Privacy Policy

**Last updated:** February 2026

## Overview

Pinterest MCP Server ("the app") is a personal productivity tool that connects Claude AI to the Pinterest API v5. It is not a commercial product and does not collect, store, or share any personal data beyond what is strictly necessary to authenticate with Pinterest.

## Data Collected

The app stores only OAuth tokens required to interact with the Pinterest API on your behalf:

- Access token
- Refresh token
- Token expiry timestamps
- Granted OAuth scopes

These are saved locally on your machine at `~/.mcp-credentials/pinterest-tokens.json` with restricted file permissions (`0o600`). They are never transmitted to any third party other than Pinterest's official API endpoints.

## Data Not Collected

The app does **not**:

- Collect your name, email address, or any personally identifiable information
- Store pin content, board names, or any Pinterest data beyond authentication tokens
- Send any data to external servers other than `api.pinterest.com`
- Use cookies or tracking technologies
- Share any data with third parties

## Pinterest API

All API calls are made directly to `https://api.pinterest.com/v5` using your own credentials. Your Pinterest data is governed by [Pinterest's Privacy Policy](https://policy.pinterest.com/privacy-policy).

## Contact

This is an open-source personal project. For questions or concerns, open an issue at [github.com/sapyx/pinterest-mcp](https://github.com/sapyx/pinterest-mcp/issues).
