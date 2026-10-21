import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('toolbar action opens the side panel in the gesture and refreshes an existing panel', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  let onClick;
  const opened = [], messages = [], behavior = [];
  const context = vm.createContext({ console, chrome: {
    action: { onClicked: { addListener(callback) { onClick = callback; } } },
    sidePanel: {
      async setPanelBehavior(options) { behavior.push(options); },
      async open(options) { opened.push(options); },
    },
    runtime: { async sendMessage(message) { messages.push(message); } },
    storage: { local: { async setAccessLevel() {} } },
  } });
  vm.runInContext(source, context);
  assert.equal(typeof onClick, 'function', 'toolbar clicks need an explicit refresh path');
  onClick({ id: 7, windowId: 12, url: 'https://example.com/story' });
  assert.equal(opened.length, 1, 'open must run before an asynchronous boundary loses the gesture');
  assert.equal(opened[0].windowId, 12);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(behavior[0].openPanelOnActionClick, false, 'explicit handler owns opening; avoid a second toggle');
  assert.equal(messages[0].type, 'yuejian:read-current-tab');
  assert.equal(messages[0].windowId, 12);
  assert.equal(messages[0].tabId, 7);
});
