# Unflare Setup Guide

This guide explains how to set up [Unflare](https://github.com/iamyegor/Unflare.git) to bypass Cloudflare protection for Apollo scraping.

## What is Unflare?

Unflare is a Node.js API service that bypasses Cloudflare protection using `puppeteer-real-browser` to automatically solve challenges and return necessary cookies and headers.

## Quick Setup with Docker

### 1. Clone and Run Unflare

```bash
# Clone the Unflare repository
git clone https://github.com/iamyegor/Unflare.git
cd Unflare

# Build and run with Docker
docker build -t unflare .
docker run -p 5002:5002 unflare
```

### 2. Alternative: Docker Compose

Create a `docker-compose.yml` file:

```yaml
services:
  unflare:
    image: ghcr.io/iamyegor/unflare
    ports:
      - "5002:5002"
```

Then run:
```bash
docker-compose up -d
```

## Environment Configuration

Add these environment variables to your `.env` file:

```bash
# Unflare Configuration
UNFLARE_URL=http://localhost:5002
UNFLARE_API_KEY=your-api-key-if-needed
```

## How It Works

1. **Apollo scraper detects Cloudflare challenge**
2. **Makes request to Unflare service** at `POST /scrape`
3. **Unflare solves the challenge** using real browser
4. **Returns valid cookies and headers** (including `cf_clearance`)
5. **Apollo scraper uses these cookies** to bypass Cloudflare

## API Request Format

The scraper sends this request to Unflare:

```json
{
  "url": "https://app.apollo.io/#/companies",
  "timeout": 60000,
  "method": "GET"
}
```

## Expected Response

```json
{
  "cookies": [
    {
      "name": "cf_clearance",
      "value": "abc123...",
      "domain": ".apollo.io",
      "path": "/",
      "expires": 1676142392.307484,
      "httpOnly": true,
      "secure": true
    }
  ],
  "headers": {
    "user-agent": "Mozilla/5.0...",
    "accept": "text/html,application/xhtml+xml...",
    "accept-language": "en-US,en;q=0.9"
  }
}
```

## Testing Unflare

Test if Unflare is working:

```bash
curl -X POST http://localhost:5002/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://app.apollo.io/#/companies", "timeout": 60000}'
```

## Troubleshooting

### Common Issues

1. **Unflare not running**: Make sure Docker container is running on port 5002
2. **Connection refused**: Check if `UNFLARE_URL` is correct
3. **No cookies returned**: Apollo might not be showing Cloudflare challenge
4. **Timeout errors**: Increase timeout value in environment

### Debug Logs

The scraper will log Unflare activity:
- `unflare_cookies_set`: Successfully set cookies from Unflare
- `unflare_headers_set`: Successfully set headers from Unflare
- `unflare_error`: Unflare returned an error
- `unflare_failed`: Network or parsing error

## Production Deployment

For production, consider:
- Running Unflare on a separate server
- Using a load balancer for multiple Unflare instances
- Setting up monitoring and health checks
- Using environment-specific URLs

## Security Notes

- Unflare handles sensitive Cloudflare challenges
- Keep your Unflare instance secure
- Consider using authentication if exposing publicly
- Monitor for abuse and rate limiting
