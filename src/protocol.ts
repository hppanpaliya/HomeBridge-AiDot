import * as dgram from 'dgram';
import * as net from 'net';
import * as crypto from 'crypto';
import AES from 'aes-js';

// --- Constants ---
const DISCOVERY_PORT = 6666;
const DISCOVERY_ADDR = '255.255.255.255';
const DEVICE_PORT = 10000;
const MAGIC = 0x1eed;
const HEARTBEAT_INTERVAL = 30_000;
const MAX_MISSED_PINGS = 3;
const RECONNECT_DELAY = 60_000;

const DISCOVERY_KEY = Buffer.from('T54uednca587'.padEnd(32, '\0'), 'utf8');
const DISCOVER_FAST = 6;
const DISCOVER_SLOW = 120;

// --- Types ---
export interface AidotDevice {
  devId: string;
  ip: string;
  mac: string;
  productModel: string;
  bindFlag: number;
  version: number;
  wifiMode: number;
  aesKey: string;
  password: string;
  name: string;
  userId: string;
}

export interface DeviceStatus {
  online: boolean;
  on: boolean;
  brightness: number; // 0-100
  rgbw: { r: number; g: number; b: number; w: number };
  cct: number;
}

export type StatusCallback = (deviceId: string, status: DeviceStatus) => void;

// --- AES Helpers ---
function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const padded = pkcs7Pad(data, 16);
  const aesCbc = new AES.ModeOfOperation.ecb(key);
  return Buffer.from(aesCbc.encrypt(padded));
}

function aesEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const aesCbc = new AES.ModeOfOperation.ecb(key);
  const decrypted = aesCbc.decrypt(data);
  return pkcs7Unpad(decrypted);
}

function pkcs7Pad(data: Buffer, blockSize: number): Uint8Array {
  const padLen = blockSize - (data.length % blockSize);
  const padded = Buffer.alloc(data.length + padLen);
  data.copy(padded);
  padded.fill(padLen, data.length);
  return padded;
}

function pkcs7Unpad(data: Uint8Array): Buffer {
  const padLen = data[data.length - 1];
  return Buffer.from(data.slice(0, data.length - padLen));
}

function normalizeAesKey(key: string): Buffer {
  const normalized = key.trim();
  if (!normalized) {
    return Buffer.alloc(16);
  }

  // Some cloud responses surface the key as a 32-char hex string, while others
  // return a raw UTF-8 token. Support both so we can talk to more devices.
  if (/^[0-9a-fA-F]{32}$/.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }

  const base64Candidate = Buffer.from(normalized, 'base64');
  if (base64Candidate.length === 16) {
    const normalizedBase64 = normalized.replace(/=+$/, '');
    const reencoded = base64Candidate.toString('base64').replace(/=+$/, '');
    if (reencoded === normalizedBase64) {
      return base64Candidate;
    }
  }

  const raw = Buffer.alloc(16);
  Buffer.from(normalized, 'utf8').copy(raw, 0, 0, 16);
  return raw;
}

// --- RGBW Encoding ---
export function packRGBW(r: number, g: number, b: number, w: number): number {
  const val = (r << 24) | (g << 16) | (b << 8) | w;
  return val | 0; // signed int32
}

export function unpackRGBW(rgbw: number): { r: number; g: number; b: number; w: number } {
  const u = rgbw >>> 0;
  return {
    r: (u >>> 24) & 0xff,
    g: (u >>> 16) & 0xff,
    b: (u >>> 8) & 0xff,
    w: u & 0xff,
  };
}

// --- Sequence Number ---
function makeSeq(loginUuid: number): string {
  const ts = Date.now();
  return String(ts + loginUuid).slice(-9);
}

// ==================== DISCOVERY ====================

export class AidotDiscovery {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fastCount = 5;
  private userId: string;
  private discovered: Map<string, string> = new Map(); // devId -> ip
  private onDevice: (devId: string, ip: string) => void;

  constructor(userId: string, onDevice: (devId: string, ip: string) => void) {
    this.userId = userId;
    this.onDevice = onDevice;
  }

  start(): void {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    this.socket.on('error', (err) => {
      console.error('[AiDot Discovery] Socket error:', err.message);
    });
    this.socket.bind(0, () => {
      const sock = this.socket!;
      sock.setBroadcast(true);
      this.scheduleBroadcast();
    });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  getDiscovered(): Map<string, string> {
    return this.discovered;
  }

  private scheduleBroadcast(): void {
    const interval = this.fastCount > 0 ? DISCOVER_FAST : DISCOVER_SLOW;
    if (this.fastCount > 0) this.fastCount--;
    this.timer = setTimeout(() => {
      this.sendBroadcast();
      this.scheduleBroadcast();
    }, interval * 1000);
    // Send first one immediately
    this.sendBroadcast();
  }

  private sendBroadcast(): void {
    if (!this.socket) return;
    const seq = makeSeq(1);
    const tst = Date.now();
    const request = {
      protocolVer: '2.0.0',
      service: 'device',
      method: 'devDiscoveryReq',
      seq,
      srcAddr: `0.${this.userId}`,
      tst,
      payload: {
        extends: {},
        localCtrFlag: 1,
        timestamp: String(tst),
      },
    };
    const json = Buffer.from(JSON.stringify(request), 'utf8');
    const encrypted = aesEcbEncrypt(json, DISCOVERY_KEY);
    this.socket.send(encrypted, 0, encrypted.length, DISCOVERY_PORT, DISCOVERY_ADDR);
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const decrypted = aesEcbDecrypt(msg, DISCOVERY_KEY);
      const json = JSON.parse(decrypted.toString('utf8'));
      if (json.method === 'devDiscoveryResp' && json.payload?.devId) {
        const devId = json.payload.devId;
        const ip = json.payload.ip || rinfo.address;
        this.discovered.set(devId, ip);
        this.onDevice(devId, ip);
      }
    } catch {
      // Ignore malformed responses from other devices
    }
  }
}

// ==================== DEVICE CLIENT ====================

export class AidotDeviceClient {
  private socket: net.Socket | null = null;
  private device: AidotDevice;
  private status: DeviceStatus = {
    online: false,
    on: false,
    brightness: 100,
    rgbw: { r: 255, g: 0, b: 0, w: 0 },
    cct: 4000,
  };
  private loginUuid = 0;
  private seqNum = 0;
  private ascNumber = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingCount = 0;
  private connected = false;
  private connecting = false;
  private closed = false;
  private buffer = Buffer.alloc(0);
  private aesKey: Buffer;
  private statusCallbacks: StatusCallback[] = [];
  private loginResolve: (() => void) | null = null;
  private loginReject: ((err: Error) => void) | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(device: AidotDevice) {
    this.device = device;
    this.aesKey = normalizeAesKey(device.aesKey);
  }

  updateDevice(device: Partial<AidotDevice>): void {
    this.device = { ...this.device, ...device };
    if (device.aesKey !== undefined) {
      this.aesKey = normalizeAesKey(this.device.aesKey);
    }
  }

  onStatusUpdate(cb: StatusCallback): void {
    this.statusCallbacks.push(cb);
  }

  getStatus(): DeviceStatus {
    return { ...this.status };
  }

  getDeviceId(): string {
    return this.device.devId;
  }

  isOnline(): boolean {
    return this.connected;
  }

  isConnecting(): boolean {
    return this.connecting;
  }

  async connect(ip: string): Promise<void> {
    if (this.closed) return;
    this.device.ip = ip;
    if (this.connected) return;
    if (this.connecting && this.connectPromise) {
      return this.connectPromise;
    }

    this.connecting = true;
    this.connectPromise = this.doConnect().finally(() => {
      this.connecting = false;
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      socket.setNoDelay(true);
      socket.connect(DEVICE_PORT, this.device.ip, () => {
        if (this.socket !== socket || this.closed) {
          try { socket.destroy(); } catch {}
          return;
        }
        this.loginResolve = resolve;
        this.loginReject = reject;
        this.login();
      });
      socket.on('data', (data) => {
        if (this.socket !== socket) return;
        this.onData(data);
      });
      socket.on('error', (err) => {
        if (this.socket !== socket) return;
        console.error(`[AiDot ${this.device.devId.slice(0, 8)}] TCP error:`, err.message);
        if (!this.connected && this.loginReject) {
          this.loginReject(err);
          this.loginResolve = null;
          this.loginReject = null;
        }
        this.reset();
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        const wasConnected = this.connected;
        this.connected = false;
        this.connecting = false;
        this.status.online = false;
        this.notifyStatus();
        if (!wasConnected && this.loginReject) {
          this.loginReject(new Error('Connection closed before login completed'));
          this.loginResolve = null;
          this.loginReject = null;
        }
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });
    });
  }

  updateIp(ip: string): void {
    if (ip && ip !== this.device.ip) {
      this.device.ip = ip;
      if (!this.connected && !this.connecting && !this.closed && this.canConnect()) {
        this.doConnect().catch(() => {});
      }
    }
  }

  // --- Commands ---
  async turnOn(): Promise<void> {
    await this.sendAction({ OnOff: 1 });
    this.status.on = true;
    this.notifyStatus();
  }

  async turnOff(): Promise<void> {
    await this.sendAction({ OnOff: 0 });
    this.status.on = false;
    this.notifyStatus();
  }

  async setBrightness(percent: number): Promise<void> {
    const dimming = Math.max(0, Math.min(100, Math.round(percent)));
    await this.sendAction({ Dimming: dimming });
    this.status.brightness = dimming;
    this.notifyStatus();
  }

  async setRGBW(r: number, g: number, b: number, w: number): Promise<void> {
    const packed = packRGBW(r, g, b, w);
    await this.sendAction({ RGBW: packed });
    this.status.rgbw = { r, g, b, w };
    this.notifyStatus();
  }

  async setCCT(kelvin: number): Promise<void> {
    const cct = Math.max(2700, Math.min(6500, Math.round(kelvin)));
    await this.sendAction({ CCT: cct });
    this.status.cct = cct;
    this.notifyStatus();
  }

  async syncAttributes(): Promise<void> {
    await this.sendAction(['OnOff', 'Dimming', 'RGBW', 'CCT'], 'getDevAttrReq');
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.status.online = false;
  }

  // --- Protocol ---
  private login(): void {
    this.loginUuid++;
    const seq = makeSeq(this.loginUuid);
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const request = {
      service: 'device',
      method: 'loginReq',
      seq,
      srcAddr: this.device.userId,
      deviceId: this.device.devId,
      payload: {
        userId: this.device.userId,
        password: this.device.password,
        timestamp,
        ascNumber: 1,
      },
    };
    this.sendPacket(1, request);
  }

  private async sendAction(attr: Record<string, unknown> | string[], method: string = 'setDevAttrReq'): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise.catch(() => {});
    }
    if (!this.connected || !this.socket) {
      throw new Error('Not connected');
    }
    this.seqNum++;
    const seq = `ha93${String(this.seqNum).padStart(5, '0')}`;
    const request = {
      method,
      service: 'device',
      clientId: `ha-${this.device.userId}`,
      srcAddr: `0.${this.device.userId}`,
      seq,
      tst: Date.now(),
      deviceId: this.device.devId,
      payload: {
        devId: this.device.devId,
        parentId: this.device.devId,
        userId: this.device.userId,
        password: this.device.password,
        attr,
        channel: 'tcp',
        ascNumber: this.ascNumber,
      },
    };
    this.sendPacket(1, request);
  }

  private sendGetAttrs(): void {
    this.sendAction(['OnOff', 'Dimming', 'RGBW', 'CCT'], 'getDevAttrReq').catch(() => {});
  }

  private sendPacket(msgType: number, obj: Record<string, unknown>): void {
    if (!this.socket) return;
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const encrypted = aesEcbEncrypt(json, this.aesKey);
    const header = Buffer.alloc(8);
    header.writeUInt16BE(MAGIC, 0);
    header.writeInt16BE(msgType, 2);
    header.writeUInt32BE(encrypted.length, 4);
    this.socket.write(Buffer.concat([header, encrypted]));
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) {
      const magic = this.buffer.readUInt16BE(0);
      if (magic !== MAGIC) {
        // Try to find magic
        const idx = this.buffer.indexOf(Buffer.from([0x1e, 0xed]));
        if (idx > 0) {
          this.buffer = this.buffer.slice(idx);
          continue;
        }
        this.buffer = Buffer.alloc(0);
        return;
      }
      const bodySize = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + bodySize) return; // Wait for more data
      const body = this.buffer.slice(8, 8 + bodySize);
      this.buffer = this.buffer.slice(8 + bodySize);
      this.handleMessage(body);
    }
  }

  private handleMessage(encryptedBody: Buffer): void {
    try {
      const decrypted = aesEcbDecrypt(encryptedBody, this.aesKey);
      const json = JSON.parse(decrypted.toString('utf8'));

      // Ping response
      if (json.service === 'test') {
        this.pingCount = 0;
        return;
      }

      // Login response
      if (json.method === 'loginResp' || (json.ack?.code === 200 && json.payload?.ascNumber !== undefined && !json.payload?.attr)) {
        if (json.ack?.code === 200) {
          this.ascNumber = json.payload.ascNumber + 1;
          this.connected = true;
          this.status.online = true;
          this.pingCount = 0;
          this.notifyStatus();
          if (this.loginResolve) {
            this.loginResolve();
            this.loginResolve = null;
            this.loginReject = null;
          }
          this.startHeartbeat();
          this.sendGetAttrs();
        } else {
          if (this.loginReject) {
            this.loginReject(new Error(`Login failed: ${json.ack?.code}`));
            this.loginResolve = null;
            this.loginReject = null;
          }
        }
        return;
      }

      // Device attribute response
      if (json.payload?.attr) {
        this.pingCount = 0;
        if (json.payload.ascNumber) {
          this.ascNumber = json.payload.ascNumber + 1;
        }
        this.updateStatus(json.payload.attr);
      }
    } catch (err) {
      console.error(`[AiDot ${this.device.devId.slice(0, 8)}] Message parse error:`, err);
    }
  }

  private updateStatus(attr: Record<string, unknown>): void {
    let changed = false;
    if ('OnOff' in attr) {
      this.status.on = attr.OnOff === 1;
      changed = true;
    }
    if ('Dimming' in attr && attr.Dimming !== null) {
      this.status.brightness = attr.Dimming as number;
      changed = true;
    }
    if ('RGBW' in attr && attr.RGBW !== null) {
      this.status.rgbw = unpackRGBW(attr.RGBW as number);
      changed = true;
    }
    if ('CCT' in attr && attr.CCT !== null) {
      this.status.cct = attr.CCT as number;
      changed = true;
    }
    if (changed) {
      this.notifyStatus();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.sendPing(), HEARTBEAT_INTERVAL);
  }

  private sendPing(): void {
    if (!this.connected || this.closed) return;
    this.pingCount++;
    if (this.pingCount >= MAX_MISSED_PINGS) {
      this.reset();
      return;
    }
    this.sendPacket(2, {
      service: 'test',
      method: 'pingreq',
      seq: '123456',
      srcAddr: '123456',
      payload: {},
    });
    this.startHeartbeat();
  }

  private reset(): void {
    this.connected = false;
    this.connecting = false;
    this.status.online = false;
    this.notifyStatus();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try { socket.destroy(); } catch {}
    }
    if (!this.closed) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed && this.device.ip) {
        this.connect(this.device.ip).catch(() => {});
      }
    }, RECONNECT_DELAY);
  }

  private notifyStatus(): void {
    for (const cb of this.statusCallbacks) {
      cb(this.device.devId, { ...this.status });
    }
  }

  private canConnect(): boolean {
    return Boolean(this.device.ip && this.device.aesKey && this.device.password && this.device.userId);
  }
}
