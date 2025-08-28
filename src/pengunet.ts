#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { chromium, BrowserContext, Page, Browser } from 'playwright';
import { CDPSession } from 'playwright';

interface NetwatchArgs {
  url: string;
  output?: string;
  headed: boolean;
  body: boolean;
  maxBodyKB: number;
  persistContext?: string;
  timeout: number;
}

interface NetworkRecord {
  id: string;
  url?: string;
  resourceType?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  requestHasPostData?: boolean;
  requestPostDataLength?: number;
  initiator?: any;
  startTime?: number;
  events?: string[];
  response?: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    remoteIPAddress?: string;
    remotePort?: number;
  };
  timing?: any;
  responseReceivedAt?: number;
  encodedDataLength?: number;
  finishedAt?: number;
  responseBody?: string;
  responseBodyEncoding?: string;
  responseBodyTruncated?: boolean;
  responseBodyBytes?: number;
  responseBodyError?: string;
  error?: {
    errorText: string;
    canceled: boolean;
  };
  failedAt?: number;
}

const argv = yargs(hideBin(process.argv))
  .option('url', {
    alias: 'u',
    type: 'string',
    describe: 'URL to open in the browser',
    demandOption: true
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    describe: 'Write JSON Lines to this file (one event per line)'
  })
  .option('headed', {
    type: 'boolean',
    describe: 'Run with a visible browser window (headful)',
    default: false
  })
  .option('body', {
    type: 'boolean',
    describe: 'Include response body when available (may be truncated)',
    default: false
  })
  .option('maxBodyKB', {
    type: 'number',
    describe: 'Max size of body to include, in KB (only if --body)',
    default: 512
  })
  .option('persistContext', {
    type: 'string',
    describe: 'Path to a user-data-dir for persistent context (keeps cookies, sessions)'
  })
  .option('timeout', {
    type: 'number',
    describe: 'Navigation timeout in ms for the initial page goto',
    default: 45000
  })
  .help()
  .strict()
  .parseSync() as NetwatchArgs;

const outStream = argv.output ? fs.createWriteStream(path.resolve(argv.output), { flags: 'a' }) : null;

function writeLine(obj: object): void {
  const line = JSON.stringify(obj);
  if (outStream) {
    outStream.write(line + '\n');
  }
  process.stdout.write(line + '\n');
}

function setupKeypress(onQuit: () => Promise<void>): readline.Interface {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  readline.emitKeypressEvents(process.stdin, rl);
  
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  
  process.stdin.on('keypress', (str: string, key: any) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      onQuit().catch(console.error);
    }
  });
  
  process.stdout.write("\n🐧 Pengunet logging network traffic. Press 'q' to stop (or Ctrl+C).\n\n");
  return rl;
}

async function closeResources(
  page: Page | null,
  context: BrowserContext | null,
  browser: Browser | null,
  outStream: fs.WriteStream | null,
  rl: readline.Interface
): Promise<void> {
  try {
    if (page) {
      await page.close({ runBeforeUnload: true }).catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser && typeof browser.close === 'function') {
      await browser.close().catch(() => {});
    }
  } finally {
    if (outStream) {
      outStream.end();
    }
    rl.close();
    process.stdout.write('\n✅ Pengunet stopped.\n');
    process.exit(0);
  }
}

(async (): Promise<void> => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let client: CDPSession | null = null;

  try {
    browser = await chromium.launch({ headless: !argv.headed });

    if (argv.persistContext) {
      await browser.close();
      browser = null;
      context = await chromium.launchPersistentContext(path.resolve(argv.persistContext), {
        headless: !argv.headed
      });
    } else {
      context = await browser.newContext();
    }

    page = await context.newPage();
    client = await context.newCDPSession(page);
    
    await client.send('Network.enable', {
      maxTotalBufferSize: 1024 * 1024 * 100,
      maxResourceBufferSize: 1024 * 1024 * 10
    });

    const store = new Map<string, NetworkRecord>();

    const flushRecord = (id: string): void => {
      const rec = store.get(id);
      if (!rec) return;
      writeLine({ type: 'pengunet', ...rec });
      store.delete(id);
    };

    client.on('Network.requestWillBeSent', (e: any) => {
      const { requestId, request, initiator, wallTime, timestamp, type } = e;
      store.set(requestId, {
        id: requestId,
        url: request.url,
        resourceType: type,
        method: request.method,
        requestHeaders: request.headers || {},
        requestHasPostData: Boolean(request.postData),
        requestPostDataLength: request.postData ? Buffer.byteLength(request.postData) : 0,
        initiator,
        startTime: wallTime || timestamp,
        events: ['requestWillBeSent']
      });
    });

    client.on('Network.responseReceived', (e: any) => {
      const { requestId, response, type, timestamp } = e;
      const rec: NetworkRecord = store.get(requestId) || { id: requestId };
      rec.response = {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers || {},
        mimeType: response.mimeType,
        remoteIPAddress: response.remoteIPAddress,
        remotePort: response.remotePort
      };
      rec.resourceType = rec.resourceType || type;
      rec.timing = response.timing || null;
      rec.responseReceivedAt = timestamp;
      rec.events = [...new Set([...(rec.events || []), 'responseReceived'])];
      store.set(requestId, rec);
    });

    client.on('Network.loadingFinished', async (e: any) => {
      const { requestId, encodedDataLength, timestamp } = e;
      const rec: NetworkRecord = store.get(requestId) || { id: requestId };
      rec.encodedDataLength = encodedDataLength;
      rec.finishedAt = timestamp;
      rec.events = [...new Set([...(rec.events || []), 'loadingFinished'])];

      if (argv.body && client) {
        try {
          const bodyRes = await client.send('Network.getResponseBody', { requestId });
          const max = Math.max(0, argv.maxBodyKB) * 1024;
          if (bodyRes.base64Encoded) {
            const buf = Buffer.from(bodyRes.body, 'base64');
            const slice = buf.subarray(0, max);
            rec.responseBody = slice.toString('base64');
            rec.responseBodyEncoding = 'base64';
            rec.responseBodyTruncated = buf.length > slice.length;
            rec.responseBodyBytes = buf.length;
          } else {
            const text = bodyRes.body || '';
            const slice = text.slice(0, max);
            rec.responseBody = slice;
            rec.responseBodyEncoding = 'utf8';
            rec.responseBodyTruncated = text.length > slice.length;
            rec.responseBodyBytes = Buffer.byteLength(text);
          }
        } catch (err: any) {
          rec.responseBodyError = String(err && err.message || err);
        }
      }

      flushRecord(requestId);
    });

    client.on('Network.loadingFailed', (e: any) => {
      const { requestId, errorText, canceled, timestamp } = e;
      const rec: NetworkRecord = store.get(requestId) || { id: requestId };
      rec.error = { errorText, canceled: Boolean(canceled) };
      rec.failedAt = timestamp;
      rec.events = [...new Set([...(rec.events || []), 'loadingFailed'])];
      flushRecord(requestId);
    });

    try {
      await page.goto(argv.url, { timeout: argv.timeout, waitUntil: 'domcontentloaded' });
    } catch (err: any) {
      console.error('Initial navigation error:', err.message);
    }

    const rl = setupKeypress(async () => {
      await closeResources(page, context, browser, outStream, rl);
    });

    const stop = (): void => {
      rl.emit('keypress', '', { name: 'q' });
    };
    
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

  } catch (err: any) {
    console.error('Fatal error:', err.message);
    await closeResources(page, context, browser, outStream, 
      readline.createInterface({ input: process.stdin, output: process.stdout }));
  }
})();