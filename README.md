# Kimi Token Counter

[![License](https://img.shields.io/badge/License-Apache%202.0-blue)](LICENSE) [![CI](https://github.com/GunnarMUC/kimi-token-counter/actions/workflows/ci.yml/badge.svg)](https://github.com/GunnarMUC/kimi-token-counter/actions) [![Node](https://img.shields.io/badge/Node-%E2%89%A520-green)](https://nodejs.org)

[![Node](https://img.shields.io/badge/Node-%E2%89%A520-green)](https://nodejs.org)

**Zero-dependency Kimi API token usage tracker & live terminal dashboard.**

Tracks every Kimi API call in real time — token counts, costs, cache hits, and span markers. 100% local. No API key leaves your machine.

---

## Quick Start

```bash
# Download (single file, zero deps)
curl -O https://raw.githubusercontent.com/GunnarMUC/kimi-token-counter/main/kimi-token-counter.js

# Start live dashboard in a terminal
node kimi-token-counter.js

# One-time snapshot
node kimi-token-counter.js --once
```

## Wrapper Modes

### Mode A — Drop-in fetch wrapper

```javascript
import { kimiFetch } from './kimi-token-counter.js';

const response = await kimiFetch('https://api.moonshot.cn/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer sk-...', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'kimi-k2-7-code', messages: [...] })
});
// Response is identical to native fetch, usage is logged automatically.
```

### Mode B — OpenAI Client Interceptor

```javascript
import { wrapOpenAIClient } from './kimi-token-counter.js';
import OpenAI from 'openai';

const client = wrapOpenAIClient(new OpenAI({
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: process.env.KIMI_API_KEY
}));
// Every client.chat.completions.create() call is logged.
```

## Span Markers

```bash
node kimi-token-counter.js mark start "Implement login"
# ... code using Kimi API ...
node kimi-token-counter.js mark end

node kimi-token-counter.js mark status   # Active span
node kimi-token-counter.js mark list     # Recent spans
node kimi-token-counter.js mark cancel   # Discard span
```

## Dashboard Layout

```
 Kimi Token Tracker                                         14:32:08
───────────────────────────────────────────────────────────
 ▶ SPAN auth system  since 14:02:11  (29m 57s)

 CURRENT SESSION  ·  default  ·  9f3c1a2b   ● live

 TODAY  2026-07-08   tokens 1,659,048   cost $4.21

 ALL TIME   tokens 41,883,902   cost $96.40

 RECENT
   14:32:01  kimi-k2-7-code  in 2  out 1,373  $0.1821
───────────────────────────────────────────────────────────
```

### Keyboard Controls

| Key | Action |
|-----|--------|
| `m` | Start/end span |
| `q` | Quit |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `KTC_DIR` | `~/.kimi-token-counter` | Base directory for logs |
| `KTC_SESSION` | auto-generated | Session ID |
| `KTC_PROJECT` | `default` | Project name |
| `NO_COLOR` | — | Disable ANSI colors |

## Data Storage

All data under `~/.kimi-token-counter/`:

| Path | Content |
|------|---------|
| `logs/daily-YYYY-MM-DD.jsonl` | All API calls per day |
| `logs/session-<id>.jsonl` | Session-specific log |
| `logs/markers.log` | Human-readable span history |
| `markers.json` | Active span state |

## Supported Models

| Model | Input | Cache Hit | Output |
|-------|-------|-----------|--------|
| Kimi K2.7 Code | $0.95/M | $0.19/M | $4.00/M |
| Kimi K2.6 | $0.95/M | $0.16/M | $4.00/M |
| Kimi K2.5 | $0.60/M | $0.10/M | $3.00/M |

Prices hardcoded in `PRICE_TABLE` at the top of the file. Edit when Kimi changes pricing.

## License

Apache 2.0 — see [LICENSE](LICENSE)

Copyright 2026 Gunnar Mueller
