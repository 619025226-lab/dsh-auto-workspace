import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const SOURCE = new URL('../lib/client.js', import.meta.url);

test('the browser bundle registers the expected slots and endpoints', async () => {
  const text = await readFile(SOURCE, 'utf8');
  assert.match(text, /window\.__ModuleLoader__\.load\(/);
  assert.match(text, /id: "dsh-auto-workspace"/);
  assert.match(text, /sidebar\.footer\.action/);
  assert.match(text, /shell\.overlay/);
  assert.match(text, /\/plugin\/dsh-auto-workspace/);
  assert.match(text, /x-dsh-auto-workspace/);
  assert.match(text, /exports\.apply = apply/);
  assert.match(text, /exports\.inject = inject/);
  // The slot entry crashes blank the whole slot, so the panel and toast must
  // stay simple function components with no top-level side effects.
  assert.match(text, /function StatusPanel\(\{ controller \}\)/);
  assert.match(text, /function ScanSection\(/);
  // The section must be mounted in the panel, not merely defined.
  assert.match(text, /h\(ScanSection, \{ key: "scan"/);
  // Version mismatch must suggest the right action for each direction.
  assert.match(text, /staleHostOlder/);
  assert.match(text, /staleClientOlder/);
  assert.match(text, /function compareBuild\(/);
  // Skipped and stayed conversations must explain themselves.
  assert.match(text, /skippedHeading/);
  assert.match(text, /async scanAndApply\(\)/);
  assert.match(text, /scanAndApply: "扫描并归类"/);
  assert.match(text, /newChat: "新建对话"/);
  assert.match(text, /async newConversation/);
  assert.match(text, /key: "newchat"/);
  assert.match(text, /\.dsh-aw-button\.dsh-aw-button-primary\{/);
  assert.match(text, /key: "scan-apply"/);
  assert.match(text, /counts\.movedExisting/);
  assert.match(text, /const untouched = items\.filter/);
  assert.match(text, /untouchedHint/);
  assert.match(text, /const BUILD = "0\.6\.1"/);
  assert.match(text, /&b=\$\{encodeURIComponent\(BUILD\)\}/);
  assert.match(text, /\/scan/);
  assert.match(text, /\/apply/);
  assert.match(text, /function FilingToast\(\{ controller \}\)/);
});

test('the client does not import Harness internals', async () => {
  const text = await readFile(SOURCE, 'utf8');
  const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(requires, ['react']);
});

test('the manifest wires the browser half to the workspace UI', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-workspace']);
  assert.equal(manifest.main, 'lib/index.js');
  assert.equal(manifest.type, 'module');
});
