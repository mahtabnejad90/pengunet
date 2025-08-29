# pengunet

A CLI tool to log browser network requests with detailed information including response headers, initiators, timing, and body content using Playwright and Chrome DevTools Protocol.

## Installation

```bash
npm install -g pengunet
```

## Usage

```bash
pengunet --url https://example.com
```

### Options

- `--url, -u <url>` - URL to open in the browser (required)
- `--output, -o <file>` - Write JSON Lines to file (one event per line)
- `--headed` - Run with visible browser window (default: false)
- `--body` - Include response body when available (default: false)
- `--maxBodyKB <number>` - Max body size in KB (default: 512)
- `--persistContext <path>` - Path to user-data-dir for persistent context
- `--timeout <ms>` - Navigation timeout in milliseconds (default: 45000)

### Examples

```bash
# Basic usage
pengunet --url https://example.com

# Save output to file with response bodies
pengunet -u https://example.com -o logs.jsonl --body

# Run with visible browser and persistent context
pengunet -u https://example.com --headed --persistContext ./user-data
```

## Output Format

Each network request is logged as a JSON object containing:

- `id` - Unique request identifier
- `url` - Request URL
- `method` - HTTP method
- `resourceType` - Type of resource (Document, Script, XHR, etc.)
- `requestHeaders` - Request headers
- `response` - Response details (status, headers, etc.)
- `timing` - Network timing information
- `initiator` - Request initiator information
- `responseBody` - Response body (if --body flag is used)

## Controls

- Press `q` or `Ctrl+C` to stop monitoring and exit