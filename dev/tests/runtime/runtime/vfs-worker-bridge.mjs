import assert from 'node:assert/strict';
import test from 'node:test';
import { createVfs } from '../../../../src/runtime/vfs.js';
import { connectVfsUpdates } from '../../../../src/runtime/vfs-worker-bridge.js';

test('worker writes, directory renames, and deletions reach the parent before drain resolves', async () => {
  const parent = createVfs();
  const worker = createVfs();
  parent.mount({ '/node/input': 'source' });
  worker.mount({ '/node/input': 'source' });
  const channel = new MessageChannel();
  const parentBridge = connectVfsUpdates(parent, channel.port1);
  const workerBridge = connectVfsUpdates(worker, channel.port2);
  try {
    worker.fs.mkdirSync('/node/output');
    worker.fs.writeFileSync('/node/output/BUILD_ID', 'build-1');
    worker.fs.writeFileSync('/node/output/page.html', '<h1>built</h1>');
    worker.fs.renameSync('/node/output', '/node/.next');
    worker.fs.unlinkSync('/node/input');
    await workerBridge.drain();
    assert.equal(parent.fs.readFileSync('/node/.next/BUILD_ID', 'utf8'), 'build-1');
    assert.equal(parent.fs.readFileSync('/node/.next/page.html', 'utf8'), '<h1>built</h1>');
    assert.equal(parent.fs.existsSync('/node/output'), false);
    assert.equal(parent.fs.existsSync('/node/input'), false);

    parent.fs.writeFileSync('/node/.next/BUILD_ID', 'build-2');
    await parentBridge.drain();
    assert.equal(worker.fs.readFileSync('/node/.next/BUILD_ID', 'utf8'), 'build-2');
  } finally {
    parentBridge.close();
    workerBridge.close();
  }
});

test('a parent relays worker changes to siblings without echoing them back', async () => {
  const parent = createVfs();
  const first = createVfs();
  const second = createVfs();
  for (const vfs of [parent, first, second]) vfs.mount({ '/node/input': 'source' });
  const firstChannel = new MessageChannel();
  const secondChannel = new MessageChannel();
  const bridges = [
    connectVfsUpdates(parent, firstChannel.port1),
    connectVfsUpdates(first, firstChannel.port2),
    connectVfsUpdates(parent, secondChannel.port1),
    connectVfsUpdates(second, secondChannel.port2),
  ];
  let firstChanges = 0;
  const unsubscribe = first.subscribeMutations(() => { firstChanges += 1; });
  try {
    first.fs.writeFileSync('/node/shared', 'worker result');
    await bridges[1].drain();
    await bridges[2].drain();
    assert.equal(second.fs.readFileSync('/node/shared', 'utf8'), 'worker result');
    assert.equal(firstChanges, 1);
  } finally {
    unsubscribe();
    for (const bridge of bridges) bridge.close();
  }
});

test('closing a connection rejects pending barriers and drops queued writes', async () => {
  const vfs = createVfs();
  vfs.mount({ '/node/input': 'source' });
  const channel = new MessageChannel();
  const scheduled = [];
  const bridge = connectVfsUpdates(vfs, channel.port1, (callback) => scheduled.push(callback));
  try {
    const pending = bridge.drain();
    vfs.fs.writeFileSync('/node/input', 'changed');
    bridge.close();
    bridge.close();
    for (const callback of scheduled) callback();
    await assert.rejects(pending, /VFS connection is closed/);
    await assert.rejects(bridge.drain(), /VFS connection is closed/);
  } finally {
    bridge.close();
    channel.port2.close();
  }
});
