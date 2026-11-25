// Run with Node's test runner and Playwright available (NODE_PATH may point at an existing install).
// A loopback mock server serves the real template/script. External browser traffic is blocked.
// No account, OAuth service, or real token is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;
let render;
const script = await readFile(new URL('../../client/public/consent.js', import.meta.url), 'utf8');

before(async () => {
  const vite = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true },
    esbuild: { jsx: 'automatic', jsxImportSource: 'hono/jsx' } });
  try {
    const { ConsentPage } = await vite.ssrLoadModule('/src/views/consent.tsx');
    render = async (bots = true) => String(await ConsentPage({
      details: { clientName: 'Dummy client', clientDomain: null, redirectHost: '127.0.0.1', redirectIsLoopback: true },
      handle: 'dummy-handle', email: 'dummy@example.test',
      bots: bots ? [{ id: 'dummy-bot', name: 'Dummy Bot' }] : [],
      selectedBotId: bots ? 'dummy-bot' : null, sharedBotNames: [],
    }).toString());
  } finally { await vite.close(); }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture({ bots = true, javaScriptEnabled = true, status = 302 } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  const posts = [];
  let onPost;
  const received = new Promise(resolve => { onPost = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const html = await render(bots);
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/consent.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(script);
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; form-action 'self'" });
      return res.end(html);
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      posts.push(new URLSearchParams(body));
      onPost();
      await pending;
      if (status === 302) { res.writeHead(302, { location: '/callback?result=dummy' }); return res.end(); }
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>接続をやり直してください</h1><a href="/authorize">やり直す</a>');
    }
    if (url.pathname === '/callback') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Dummy callback</h1>');
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  context.on('close', () => { server.closeAllConnections(); server.close(); });
  await page.goto(`${origin}/authorize?client_id=dummy`);
  return { context, page, posts, release, received };
}

for (const decision of ['approve', 'deny']) {
  test(`${decision}: rapid clicks and repeated submit send one native POST and preserve fields`, async () => {
    const f = await fixture();
    try {
      const request = f.page.waitForRequest(r => r.method() === 'POST');
      const state = await f.page.locator(`button[value="${decision}"]`).evaluate(button => {
        button.click();
        button.click();
        button.form.requestSubmit();
        button.form.querySelector('button[value="deny"]').click();
        return { disabled: button.form.querySelectorAll('button:disabled').length, busy: button.form.getAttribute('aria-busy') };
      });
      await request;
      await f.received;
      assert.equal(state.disabled, 2);
      assert.equal(state.busy, 'true');
      assert.equal(f.posts.length, 1);
      assert.deepEqual([...f.posts[0]], [['handle', 'dummy-handle'], ['bot_id', 'dummy-bot'], ['decision', decision]]);
      f.release();
      await f.page.waitForURL('**/callback?result=dummy');
    } finally { f.release(); await f.context.close(); }
  });
}

test('keyboard approval with no bots preserves the empty bot selection', async () => {
  const f = await fixture({ bots: false });
  try {
    await f.page.locator('button[value="approve"]').focus();
    const request = f.page.waitForRequest(r => r.method() === 'POST');
    await f.page.keyboard.press('Enter');
    await request;
    await f.received;
    assert.equal(f.posts[0].get('decision'), 'approve');
    assert.equal(f.posts[0].get('bot_id'), '');
    f.release();
    await f.page.waitForURL('**/callback?result=dummy');
  } finally { f.release(); await f.context.close(); }
});

for (const status of [400, 401, 500]) {
  test(`native ${status} error navigation remains available`, async () => {
    const f = await fixture({ status });
    try {
      const response = f.page.waitForResponse(r => r.request().method() === 'POST');
      f.release();
      await f.page.locator('button[value="approve"]').click();
      assert.equal((await response).status(), status);
      await f.page.getByRole('link', { name: 'やり直す' }).click();
      assert.equal(await f.page.locator('button:disabled').count(), 0);
    } finally { f.release(); await f.context.close(); }
  });
}

test('native approval still works without JavaScript', async () => {
  const f = await fixture({ javaScriptEnabled: false });
  try {
    f.release();
    await f.page.locator('button[value="approve"]').click();
    await f.page.waitForURL('**/callback?result=dummy');
    assert.equal(f.posts[0].get('decision'), 'approve');
  } finally { await f.context.close(); }
});

test('restored page removes the pending decision and unlocks both buttons', async () => {
  const f = await fixture();
  try {
    // Cancel only the native navigation to simulate restoring this document from bfcache.
    await f.page.evaluate(() => {
      document.querySelector('form').addEventListener('submit', event => event.preventDefault());
      document.querySelector('button[value="approve"]').click();
    });
    assert.equal(await f.page.locator('button:disabled').count(), 2);
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal(await f.page.locator('button:disabled').count(), 0);
    assert.equal(await f.page.locator('input[name="decision"]').count(), 0);
    assert.equal(await f.page.locator('form').getAttribute('aria-busy'), null);
  } finally { f.release(); await f.context.close(); }
});
