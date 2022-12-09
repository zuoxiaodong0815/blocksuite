/**
 * @module provider/websocket
 */

/* eslint-env browser */

import type * as Y from 'yjs';
import * as bc from 'lib0/broadcastchannel';
import * as time from 'lib0/time';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as authProtocol from 'y-protocols/auth';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Observable } from 'lib0/observable';
import * as math from 'lib0/math';
import * as url from 'lib0/url';

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;

type MESSAGE_HANDLE = (
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: WebsocketProvider,
  emitSynced: boolean,
  messageType: number
) => void;
/**
 *                       encoder,          decoder,          provider,          emitSynced, messageType
 * @type {Array<function(encoding.Encoder, decoding.Decoder, WebsocketProvider, boolean,    number):void>}
 */
const messageHandlers: MESSAGE_HANDLE[] = [];

messageHandlers[messageSync] = (
  encoder,
  decoder,
  provider,
  emitSynced,
  _messageType
) => {
  let docGuid = provider.roomname;
  const oldpos = decoder.pos;
  let hasGuid = true;
  try {
    docGuid = decoding.readVarString(decoder);
    if (!provider.doc.getMap().get(docGuid) && docGuid !== provider.roomname) {
      docGuid = provider.roomname;
      decoder.pos = oldpos;
      hasGuid = false;
    }
  } catch {
    decoder.pos = oldpos;
    hasGuid = false;
  }

  const doc = provider.getDoc(docGuid);
  if (!doc || decoder.pos === decoder.arr.length) {
    return;
  }

  encoding.writeVarUint(encoder, messageSync);
  hasGuid && encoding.writeVarString(encoder, docGuid);
  const syncMessageType = syncProtocol.readSyncMessage(
    decoder,
    encoder,
    doc,
    provider
  );

  // main doc synced
  if (
    emitSynced &&
    docGuid === provider.roomname &&
    syncMessageType === syncProtocol.messageYjsSyncStep2 &&
    !provider.synced
  ) {
    provider.synced = true;
  }

  // sub doc synced
  if (
    emitSynced &&
    docGuid !== provider.roomname &&
    syncMessageType === syncProtocol.messageYjsSyncStep2 &&
    !provider.syncedStatus.get(docGuid)
  ) {
    provider.updateSyncedStatus(docGuid, true);
  }
};

messageHandlers[messageQueryAwareness] = (
  encoder,
  _decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(
      provider.awareness,
      Array.from(provider.awareness.getStates().keys())
    )
  );
};

messageHandlers[messageAwareness] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  awarenessProtocol.applyAwarenessUpdate(
    provider.awareness,
    decoding.readVarUint8Array(decoder),
    provider
  );
};

messageHandlers[messageAuth] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  authProtocol.readAuthMessage(decoder, provider.doc, (_ydoc, reason) =>
    permissionDeniedHandler(provider, reason)
  );
};

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

/**
 * @param {WebsocketProvider} provider
 * @param {string} reason
 */
const permissionDeniedHandler = (provider: WebsocketProvider, reason: string) =>
  console.warn(`Permission denied to access ${provider.url}.\n${reason}`);

/**
 * @param {WebsocketProvider} provider
 * @param {Uint8Array} buf
 * @param {boolean} emitSynced
 * @return {encoding.Encoder}
 */
const readMessage = (
  provider: WebsocketProvider,
  buf: Uint8Array,
  emitSynced: boolean
) => {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  const messageHandler = provider.messageHandlers[messageType];
  if (messageHandler) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType);
  } else {
    console.error('Unable to compute message');
  }
  return encoder;
};

/**
 *
 * @param {encoding.Encoder} encoder
 */
const needSend = (encoder: encoding.Encoder) => {
  const buf = encoding.toUint8Array(encoder);
  const decoder = decoding.createDecoder(buf);
  decoding.readVarUint(decoder);
  decoding.readVarString(decoder);
  return decoding.hasContent(decoder);
};

/**
 * @param {WebsocketProvider} provider
 */
const setupWS = (provider: WebsocketProvider) => {
  if (provider.shouldConnect && provider.ws === null) {
    const websocket = new provider.WS(provider.url);
    websocket.binaryType = 'arraybuffer';
    provider.ws = websocket;
    provider.wsconnecting = true;
    provider.wsconnected = false;
    provider.synced = false;

    websocket.onmessage = event => {
      provider.wsLastMessageReceived = time.getUnixTime();
      // @todo disable emitSync for now, should also notify sub docs
      const encoder = readMessage(provider, new Uint8Array(event.data), true);
      if (encoding.length(encoder) > 1 && needSend(encoder)) {
        websocket.send(encoding.toUint8Array(encoder));
      }
    };
    websocket.onerror = event => {
      provider.emit('connection-error', [event, provider]);
    };
    websocket.onclose = event => {
      provider.emit('connection-close', [event, provider]);
      provider.ws = null;
      provider.wsconnecting = false;
      if (provider.wsconnected) {
        provider.wsconnected = false;
        provider.synced = false;
        // update awareness (all users except local left)
        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          Array.from(provider.awareness.getStates().keys()).filter(
            client => client !== provider.doc.clientID
          ),
          provider
        );
        provider.emit('status', [
          {
            status: 'disconnected',
          },
        ]);
      } else {
        provider.wsUnsuccessfulReconnects++;
      }
      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      );
    };
    websocket.onopen = () => {
      provider.wsLastMessageReceived = time.getUnixTime();
      provider.wsconnecting = false;
      provider.wsconnected = true;
      provider.wsUnsuccessfulReconnects = 0;

      // always send sync step 1 when connected (main doc & sub docs)
      for (const [k, doc] of provider.docs) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        encoding.writeVarString(encoder, k);
        syncProtocol.writeSyncStep1(encoder, doc);
        websocket.send(encoding.toUint8Array(encoder));
      }

      // broadcast local awareness state
      if (provider.awareness.getLocalState() !== null) {
        const encoderAwarenessState = encoding.createEncoder();
        encoding.writeVarUint(encoderAwarenessState, messageAwareness);
        encoding.writeVarUint8Array(
          encoderAwarenessState,
          awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
            provider.doc.clientID,
          ])
        );
        websocket.send(encoding.toUint8Array(encoderAwarenessState));
      }

      provider.emit('status', [
        {
          status: 'connected',
        },
      ]);
    };

    provider.emit('status', [
      {
        status: 'connecting',
      },
    ]);
  }
};

/**
 * @param {WebsocketProvider} provider
 * @param {ArrayBuffer} buf
 */
const broadcastMessage = (provider: WebsocketProvider, buf: ArrayBuffer) => {
  if (provider.wsconnected) {
    /** @type {WebSocket} */ provider.ws?.send(buf);
  }
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, buf, provider);
  }
};

/**
 * Websocket Provider for Yjs. Creates a websocket connection to sync the shared document.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to http://localhost:1234/my-document-name
 *
 * @example
 *   import * as Y from 'yjs'
 *   import { WebsocketProvider } from 'y-websocket'
 *   const doc = new Y.Doc()
 *   const provider = new WebsocketProvider('http://localhost:1234', 'my-document-name', doc)
 *
 * @extends {Observable<string>}
 */
export class WebsocketProvider extends Observable<string> {
  _maxBackoffTime: number;
  _bcChannel: string;
  _url: string;
  _roomname: string;
  _doc: Y.Doc;
  _awareness: awarenessProtocol.Awareness;
  _wsconnected: boolean;
  _wsconnecting: boolean;
  _bcconnected: boolean;
  _WS: {
    new (
      url: string | URL,
      protocols?: string | string[] | undefined
    ): WebSocket;
    prototype: WebSocket;
    readonly CLOSED: number;
    readonly CLOSING: number;
    readonly CONNECTING: number;
    readonly OPEN: number;
  };
  _disableBc: boolean;
  _wsUnsuccessfulReconnects: number;
  _messageHandlers: MESSAGE_HANDLE[];
  _synced: boolean;
  _ws: WebSocket | null;
  _wsLastMessageReceived: number;
  _shouldConnect: boolean;
  _docs: Map<string, Y.Doc>;
  _subdocUpdateHandlers: Map<
    string,
    (update: Uint8Array, origin: unknown) => void
  >;
  _syncedStatus: Map<string, boolean>;
  _resyncInterval: number | NodeJS.Timer;
  _checkInterval: NodeJS.Timer;
  /**
   * @param {string} serverUrl
   * @param {string} roomname
   * @param {Y.Doc} doc
   * @param {object} [opts]
   * @param {boolean} [opts.connect]
   * @param {awarenessProtocol.Awareness} [opts.awareness]
   * @param {Object<string,string>} [opts.params]
   * @param {typeof WebSocket} [opts.WebSocketPolyfill] Optionall provide a WebSocket polyfill
   * @param {number} [opts.resyncInterval] Request server state every `resyncInterval` milliseconds
   * @param {number} [opts.maxBackoffTime] Maximum amount of time to wait before trying to reconnect (we try to reconnect using exponential backoff)
   * @param {boolean} [opts.disableBc] Disable cross-tab BroadcastChannel communication
   */
  constructor(
    serverUrl: string,
    roomname: string,
    doc: Y.Doc,
    {
      connect = true,
      awareness = new awarenessProtocol.Awareness(doc),
      params = {},
      WebSocketPolyfill = WebSocket,
      resyncInterval = -1,
      maxBackoffTime = 2500,
      disableBc = false,
    } = {}
  ) {
    super();
    // ensure that url is always ends with /
    while (serverUrl[serverUrl.length - 1] === '/') {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1);
    }
    const encodedParams = url.encodeQueryParams(params);
    this._maxBackoffTime = maxBackoffTime;
    this._bcChannel = serverUrl + '/' + roomname;
    this._url =
      serverUrl +
      '/' +
      roomname +
      (encodedParams.length === 0 ? '' : '?' + encodedParams);
    this._roomname = roomname;
    this._doc = doc;
    this._WS = WebSocketPolyfill;
    this._awareness = awareness;
    this._wsconnected = false;
    this._wsconnecting = false;
    this._bcconnected = false;
    this._disableBc = disableBc;
    this._wsUnsuccessfulReconnects = 0;
    this._messageHandlers = messageHandlers.slice();
    /**
     * @type {boolean}
     */
    this._synced = false;
    /**
     * @type {WebSocket?}
     */
    this._ws = null;
    this._wsLastMessageReceived = 0;
    /**
     * Whether to connect to other peers or not
     * @type {boolean}
     */
    this._shouldConnect = connect;
    /**
     * manage all sub docs with main doc self
     * @type {Map}
     */
    this._docs = new Map();
    this._docs.set(this._roomname, doc);
    this._subdocUpdateHandlers = new Map();

    /**
     * store synced status for sub docs
     */
    this._syncedStatus = new Map();

    this._bcSubscriber = this._bcSubscriber.bind(this);
    this._updateHandler = this._updateHandler.bind(this);
    this._awarenessUpdateHandler = this._awarenessUpdateHandler.bind(this);
    this._unloadHandler = this._unloadHandler.bind(this);
    this._getSubDocUpdateHandler = this._getSubDocUpdateHandler.bind(this);

    /**
     * @type {number}
     */
    this._resyncInterval = 0;
    if (resyncInterval > 0) {
      this._resyncInterval = /** @type {any} */ setInterval(() => {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          // resend sync step 1
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.writeSyncStep1(encoder, doc);
          this._ws.send(encoding.toUint8Array(encoder));
        }
      }, resyncInterval);
    }

    this._doc.on('update', this._updateHandler);
    if (typeof window !== 'undefined') {
      window.addEventListener('unload', this._unloadHandler);
    } else if (typeof process !== 'undefined') {
      // eslint-disable-next-line no-undef
      process.on('exit', this._unloadHandler);
    }
    awareness.on('update', this._awarenessUpdateHandler);
    this._checkInterval = /** @type {any} */ setInterval(() => {
      if (
        this._wsconnected &&
        messageReconnectTimeout <
          time.getUnixTime() - this._wsLastMessageReceived
      ) {
        // no message received in a long time - not even your own awareness
        // updates (which are updated every 15 seconds)
        /** @type {WebSocket} */ this._ws?.close();
      }
    }, messageReconnectTimeout / 10);
    if (connect) {
      this.connect();
    }
  }

  public get maxBackoffTime() {
    return this._maxBackoffTime;
  }

  public get bcChannel() {
    return this._bcChannel;
  }

  public get url() {
    return this._url;
  }

  public get roomname() {
    return this._roomname;
  }

  public get doc() {
    return this._doc;
  }

  public get syncedStatus() {
    return this._syncedStatus;
  }

  public get awareness() {
    return this._awareness;
  }

  public get messageHandlers() {
    return this._messageHandlers;
  }

  public get shouldConnect() {
    return this._shouldConnect;
  }

  public get ws() {
    return this._ws;
  }

  public set ws(ws: WebSocket | null) {
    this._ws = ws;
  }

  public get WS() {
    return this._WS;
  }

  public get wsconnected() {
    return this._wsconnected;
  }

  public set wsconnected(wsconnected: boolean) {
    this._wsconnected = wsconnected;
  }

  public get wsconnecting() {
    return this._wsconnecting;
  }

  public set wsconnecting(wsconnecting: boolean) {
    this._wsconnecting = wsconnecting;
  }

  public get wsLastMessageReceived() {
    return this._wsLastMessageReceived;
  }

  public set wsLastMessageReceived(wsLastMessageReceived: number) {
    this._wsLastMessageReceived = wsLastMessageReceived;
  }

  public get wsUnsuccessfulReconnects() {
    return this._wsUnsuccessfulReconnects;
  }

  public set wsUnsuccessfulReconnects(wsUnsuccessfulReconnects: number) {
    this._wsUnsuccessfulReconnects = wsUnsuccessfulReconnects;
  }

  public get docs() {
    return this._docs;
  }

  public get bcconnected() {
    return this._bcconnected;
  }

  /**
   * @param {ArrayBuffer} data
   * @param {any} origin
   */
  _bcSubscriber(data: ArrayBuffer, origin: unknown) {
    if (origin !== this) {
      const encoder = readMessage(this, new Uint8Array(data), false);
      if (encoding.length(encoder) > 1) {
        bc.publish(this._bcChannel, encoding.toUint8Array(encoder), this);
      }
    }
  }

  /**
   * Listens to Yjs updates and sends them to remote peers (ws and broadcastchannel)
   * @param {Uint8Array} update
   * @param {any} origin
   */
  _updateHandler(update: Uint8Array, origin: unknown) {
    if (origin !== this) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      encoding.writeVarString(encoder, this._roomname);
      syncProtocol.writeUpdate(encoder, update);
      broadcastMessage(this, encoding.toUint8Array(encoder));
    }
  }

  /**
   * @param {any} changed
   * @param {any} _origin
   */
  _awarenessUpdateHandler(
    diff: {
      added: number[];
      removed: number[];
      updated: number[];
    },
    _origin: unknown
  ) {
    const { added, removed, updated } = diff;
    const changedClients = added.concat(updated).concat(removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
    );
    broadcastMessage(this, encoding.toUint8Array(encoder));
  }

  _unloadHandler() {
    awarenessProtocol.removeAwarenessStates(
      this._awareness,
      [this.doc.clientID],
      'window unload'
    );
  }

  /**
   * Listen to sub documents updates
   * @param {String} id identifier of sub documents
   * @returns
   */
  _getSubDocUpdateHandler(id: string) {
    return (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      encoding.writeVarString(encoder, id);
      syncProtocol.writeUpdate(encoder, update);
      broadcastMessage(this, encoding.toUint8Array(encoder));
    };
  }
  /**
   * @param {Y.Doc} subdoc
   */
  addSubdoc(subdoc: Y.Doc) {
    const updateHandler = this._getSubDocUpdateHandler(subdoc.guid);
    this._docs.set(subdoc.guid, subdoc);
    subdoc.on('update', updateHandler);
    this._subdocUpdateHandlers.set(subdoc.guid, updateHandler);

    // invoke sync step1
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    encoding.writeVarString(encoder, subdoc.guid);
    syncProtocol.writeSyncStep1(encoder, subdoc);
    broadcastMessage(this, encoding.toUint8Array(encoder));
  }

  /**
   * @param {Y.Doc} subdoc
   */
  removeSubdoc(subdoc: Y.Doc) {
    const func = this._subdocUpdateHandlers.get(subdoc.guid);
    func && subdoc.off('update', func);
  }

  /**
   * get doc by id (main doc or sub doc)
   * @param {String} id
   * @returns
   */
  getDoc(id: string) {
    return this._docs.get(id);
  }

  /**
   * @type {boolean}
   */
  get synced() {
    return this._synced;
  }

  set synced(state) {
    if (this._synced !== state) {
      this._synced = state;
      this.emit('synced', [state]);
      this.emit('sync', [state]);
    }
  }

  updateSyncedStatus(id: string, state: boolean) {
    const oldState = this._syncedStatus.get(id);
    if (oldState !== state) {
      this._syncedStatus.set(id, state);
      this.emit('subdoc_synced', [id, state]);
    }
  }

  destroy() {
    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval);
    }
    clearInterval(this._checkInterval);
    this.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('unload', this._unloadHandler);
    } else if (typeof process !== 'undefined') {
      // eslint-disable-next-line no-undef
      process.off('exit', this._unloadHandler);
    }
    this._awareness.off('update', this._awarenessUpdateHandler);
    this._doc.off('update', this._updateHandler);
    super.destroy();
  }

  connectBc() {
    if (this._disableBc) {
      return;
    }
    if (!this._bcconnected) {
      bc.subscribe(this._bcChannel, this._bcSubscriber);
      this._bcconnected = true;
    }
    // send sync step1 to bc
    // write sync step 1
    const encoderSync = encoding.createEncoder();
    encoding.writeVarUint(encoderSync, messageSync);
    syncProtocol.writeSyncStep1(encoderSync, this._doc);
    bc.publish(this._bcChannel, encoding.toUint8Array(encoderSync), this);
    // broadcast local state
    const encoderState = encoding.createEncoder();
    encoding.writeVarUint(encoderState, messageSync);
    syncProtocol.writeSyncStep2(encoderState, this._doc);
    bc.publish(this._bcChannel, encoding.toUint8Array(encoderState), this);
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
    bc.publish(
      this._bcChannel,
      encoding.toUint8Array(encoderAwarenessQuery),
      this
    );
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder();
    encoding.writeVarUint(encoderAwarenessState, messageAwareness);
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this._awareness, [
        this._doc.clientID,
      ])
    );
    bc.publish(
      this._bcChannel,
      encoding.toUint8Array(encoderAwarenessState),
      this
    );
  }

  disconnectBc() {
    // broadcast message with local awareness state set to null (indicating disconnect)
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        this._awareness,
        [this._doc.clientID],
        new Map()
      )
    );
    broadcastMessage(this, encoding.toUint8Array(encoder));
    if (this._bcconnected) {
      bc.unsubscribe(this._bcChannel, this._bcSubscriber);
      this._bcconnected = false;
    }
  }

  disconnect() {
    this._shouldConnect = false;
    this.disconnectBc();
    if (this._ws !== null) {
      this._ws.close();
    }
  }

  connect() {
    this._shouldConnect = true;
    if (!this._wsconnected && this._ws === null) {
      setupWS(this);
      this.connectBc();
    }
  }
}
