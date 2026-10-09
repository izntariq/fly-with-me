// Headless Chrome for the browser tools: $CHROME (the path to a Chrome or Chromium binary) if set, else the installed
// Google Chrome (playwright's 'chrome' channel, which knows where it lives on macOS, Linux and Windows), else a browser
// installed for playwright (npx playwright install chromium).
import { chromium } from './node_modules/playwright-core/index.mjs';

export async function launchChrome(opts = {}) {
  if (process.env.CHROME) return chromium.launch({ ...opts, executablePath: process.env.CHROME });
  return chromium.launch({ ...opts, channel: 'chrome' }).catch((e) => chromium.launch(opts).catch(() => {
    throw new Error(`no Chrome found (${e.message.split('\n')[0]}); install Google Chrome or set CHROME=/path/to/chrome`);
  }));
}
