const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ArenaMatch } = require('../src/features/arena-fighter/arena-match.ts');
const { ArenaNetwork } = require('../src/features/arena-fighter/arena-network.ts');
const { ArenaRemoteRoom } = require('../src/features/arena-fighter/arena-remote-room.ts');

const GUEST_LOBBY_TIMEOUT =
  'The host isn’t connected. Ask them to tap Retry connection, then retry joining.';
const PLACE_ARENA = 'Waiting for your opponent to place their arena.';
const TABLE_SURFACE = 'Tap a blue surface on your own table to place the arena.';

function relay({ syncOnConnect = true } = {}) {
  const listeners = new Set();
  const entities = new Map();
  return {
    state: 'idle',
    localPeerId: 'local',
    error: undefined,
    claims: [],
    writes: 0,
    entities,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      for (const fn of [...listeners]) fn();
    },
    connect() {
      if (!syncOnConnect) return;
      this.state = 'synced';
      this.emit();
    },
    disconnect() {
      this.state = 'idle';
      this.emit();
    },
    get(id) {
      return entities.get(id);
    },
    claim(id) {
      this.claims.push(id);
      entities.set(id, { id, fields: {}, owner: 'local', version: 1 });
      this.emit();
    },
    set(id, fields) {
      this.writes += 1;
      entities.set(id, { ...entities.get(id), fields });
    },
    release() {},
  };
}

function remoteMatch(mode, clock) {
  return new ArenaMatch(mode, 3, clock, { cpuEnabled: false }, mode, 'remote');
}

function readyVirtually(match) {
  const token = match.attachSession(1);
  match.setLandscape(true);
  match.setVirtualReady(token, true);
  for (const asset of ['arena', 'blue', 'red']) {
    match.assetLoaded(token, match.getSnapshot().placementVersion, asset);
  }
  return token;
}

function config() {
  return { roomId: 'arena-remote-v1:TESTCODE', apiKey: 'test', projectId: 'test' };
}

test('a remote pair can ready from virtual readiness without placement, and lobby disconnect does not pause', () => {
  const clock = () => 0;
  const host = remoteMatch('host', clock);
  const guest = remoteMatch('guest', clock);
  readyVirtually(host);
  readyVirtually(guest);

  for (const match of [host, guest]) {
    const snap = match.getSnapshot();
    assert.equal(match.round.isVirtualReady(), true);
    assert.equal(match.round.hasNormalTracking(), false);
    assert.equal(match.round.isReady(), true);
    assert.equal(snap.placed, false);
    assert.equal(snap.canTransform, false);
    assert.equal(snap.stage, 'lobby');
    assert.equal(snap.message, PLACE_ARENA);
  }

  host.setNetwork(true);
  guest.setNetwork(true);
  guest.receivePacket(host.packet());
  host.receiveInput(guest.input());

  assert.equal(host.ready(), true);
  assert.equal(guest.ready(), true);
  assert.equal(host.getSnapshot().localReady, true);
  assert.equal(guest.getSnapshot().localReady, true);
  assert.equal(host.getSnapshot().stage, 'lobby');
  assert.equal(guest.getSnapshot().stage, 'lobby');

  host.setNetwork(false);
  const dropped = host.getSnapshot();
  assert.equal(dropped.stage, 'lobby');
  assert.equal(dropped.localReady, false);
  assert.notEqual(dropped.stage, 'paused');
  assert.notEqual(dropped.stage, 'abandoned');

  host.dispose();
  guest.dispose();
});

test('guest lobby timeout fails closed after 30 seconds and the host seat does not', () => {
  let now = 0;
  const guest = remoteMatch('guest', () => now);
  const publisher = remoteMatch('host', () => now);
  const client = relay();
  const network = new ArenaNetwork(guest, client, config(), 'TESTCODE', () => now);
  client.entities.set('host', {
    id: 'host',
    owner: 'host-peer',
    version: 1,
    fields: { packet: publisher.packet() },
  });
  client.emit();
  client.entities.get('host').fields.packet = publisher.packet();
  client.emit();
  assert.equal(client.claims.includes('guest'), true);
  assert.equal(guest.getSnapshot().stage, 'lobby');

  now += 30001;
  network.pump();
  assert.equal(network.failure, true);
  assert.equal(guest.getSnapshot().networkMessage, GUEST_LOBBY_TIMEOUT);
  assert.equal(guest.getSnapshot().stage, 'lobby');
  network.close();

  let hostNow = 0;
  const host = remoteMatch('host', () => hostNow);
  const hostClient = relay();
  const hostNetwork = new ArenaNetwork(host, hostClient, config(), 'TESTCODE', () => hostNow);
  assert.equal(hostClient.claims.includes('host'), true);
  hostNow += 30001;
  hostNetwork.pump();
  assert.equal(hostNetwork.failure, false);
  assert.equal(host.getSnapshot().stage, 'lobby');
  assert.equal(host.getSnapshot().networkMessage.includes('isn’t connected'), false);
  hostNetwork.close();
  publisher.dispose();
});

test('a claimed host rejects a guest input with the wrong protocol and stays in the lobby', () => {
  const host = remoteMatch('host', () => 0);
  const client = relay();
  const network = new ArenaNetwork(host, client, config(), 'TESTCODE', () => 0);
  assert.equal(client.claims.includes('host'), true);
  client.entities.set('guest', {
    id: 'guest',
    owner: 'guest-peer',
    version: 1,
    fields: { input: { protocol: 11 } },
  });
  client.emit();
  assert.equal(network.failure, true);
  assert.match(host.getSnapshot().networkMessage, /different app version/);
  assert.equal(host.getSnapshot().stage, 'lobby');
  network.close();
});

test('remote room status stays joining until connected, then placing, then error on abandon', () => {
  const match = remoteMatch('host', () => 0);
  const client = relay({ syncOnConnect: false });
  const room = new ArenaRemoteRoom(match, config(), 'ABCDEFGHJKMN', client);
  room.start();
  assert.equal(room.getSnapshot().status, 'joining');
  assert.equal(room.getSnapshot().preview, null);

  client.state = 'synced';
  client.emit();
  const placed = room.getSnapshot();
  assert.equal(placed.status, 'placing');
  assert.equal(placed.preview, null);
  assert.equal(placed.message, TABLE_SURFACE);

  match.abandon('The other player left. No winner awarded.');
  const failed = room.getSnapshot();
  assert.equal(failed.status, 'error');
  assert.equal(failed.message, match.getSnapshot().networkMessage);
  room.dispose();
});
