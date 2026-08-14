---
name: web-curl
description: Use when fetching web content, testing API endpoints, or downloading resources. Provides a structured approach to making HTTP requests with error handling and response parsing.
---

# Web Curl

Structured approach to making HTTP requests for web content fetching, API testing, and resource downloading.

## When to Use

- Fetching documentation or reference pages from the web
- Testing REST API endpoints during development
- Downloading resources (JSON, HTML, files)
- Verifying external service availability

## Request Methods

### GET (Default)
```bash
curl -s -o /tmp/response.txt -w "%{http_code}" "https://api.example.com/endpoint"
```

### POST with JSON
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"key": "value"}' \
  "https://api.example.com/endpoint"
```

### With Authentication
```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://api.example.com/endpoint"
```

## Response Handling

### Status Code Check
- 2xx: Success — process the response body
- 3xx: Redirect — follow if needed
- 4xx: Client error — check request format
- 5xx: Server error — retry or report

### Output Parsing
- JSON: Use `jq` for structured extraction
- HTML: Use `grep`/`sed` for text extraction
- Binary: Save to file and inspect

## Safety Rules

- Always set timeouts (`--connect-timeout 10 --max-time 30`)
- Never follow redirects blindly (`-L` with `-max-redirs 3`)
- Log requests for debugging (`-v` flag when needed)
- Respect rate limits — add delays between requests
- Never expose secrets in URLs or headers

## Common Patterns

### Health Check
```bash
curl -sf http://localhost:3000/health || echo "Service down"
```

### API Validation
```bash
response=$(curl -s -w "\n%{http_code}" "https://api.example.com/data")
http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | head -n -1)
```

### Download with Progress
```bash
curl -# -o /tmp/file.zip "https://example.com/file.zip"
```
