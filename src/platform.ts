import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { AiDotCloudClient } from './aidot-cloud';
import { AidotDiscovery, AidotDevice, AidotDeviceClient } from './protocol';
import { AidotLightAccessory } from './accessory';

const CLOUD_SYNC_RETRY_DELAY = 60_000;
const CLOUD_SYNC_MAX_RETRIES = 5;

function normalizeCloudAesKey(aesKey?: string[]): string {
  if (!aesKey || aesKey.length === 0) {
    return '';
  }

  // AiDot has surfaced this as a single string in some payloads and as a
  // segmented array in others. Joining preserves both forms reasonably well.
  const joined = aesKey.join('');
  return joined.trim() || aesKey.find((key) => key.trim().length > 0) || '';
}

const PLATFORM_NAME = 'AiDot';
const PLUGIN_NAME = 'homebridge-aidot';

interface AiDotPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  countryCode?: string;
  userId?: string;
  removeStaleDevices?: boolean;
  debug?: boolean;
}

export class AiDotPlatform implements DynamicPlatformPlugin {
  public readonly Service;
  public readonly Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  private readonly log: Logging;
  private readonly config: AiDotPlatformConfig;
  private readonly api: API;
  private discovery: AidotDiscovery | null = null;
  private deviceClients = new Map<string, AidotDeviceClient>();
  private initializedAccessories = new Set<string>();
  private cloud: AiDotCloudClient | null = null;
  private cloudRetryTimer: NodeJS.Timeout | null = null;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as AiDotPlatformConfig;
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.connectCachedAccessories();
      this.startDiscovery();
    });

    this.api.on('shutdown', () => {
      this.shutdown();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
    this.configureAccessoryServices(accessory);
  }

  // Cached accessories carry the device's last known IP and AES key, so we
  // can reconnect immediately at startup instead of waiting for cloud login
  // or a LAN discovery response.
  private connectCachedAccessories(): void {
    for (const accessory of this.accessories) {
      const device = accessory.context.device as AidotDevice | undefined;
      if (device?.devId) {
        this.ensureClient(device, accessory);
      }
    }
  }

  private startDiscovery(): void {
    const userId = this.config.userId || this.config.username || '0';
    this.discovery = new AidotDiscovery(
      userId,
      (devId, ip) => {
        this.onDeviceFound(devId, ip, userId);
      },
      (msg) => this.log.warn(msg),
    );
    this.discovery.start();
    this.log.info('AiDot LAN discovery started');

    this.syncCloudDevicesWithRetry(0);
  }

  private shutdown(): void {
    if (this.cloudRetryTimer) {
      clearTimeout(this.cloudRetryTimer);
      this.cloudRetryTimer = null;
    }
    this.discovery?.stop();
    this.discovery = null;
    for (const client of this.deviceClients.values()) {
      client.close().catch(() => {});
    }
  }

  private syncCloudDevicesWithRetry(attempt: number): void {
    this.syncCloudDevices().catch((err) => {
      if (attempt < CLOUD_SYNC_MAX_RETRIES) {
        this.log.warn(
          `AiDot cloud sync failed (attempt ${attempt + 1}/${CLOUD_SYNC_MAX_RETRIES + 1}), ` +
          `retrying in ${CLOUD_SYNC_RETRY_DELAY / 1000}s: ${err.message}`,
        );
        this.cloudRetryTimer = setTimeout(
          () => this.syncCloudDevicesWithRetry(attempt + 1),
          CLOUD_SYNC_RETRY_DELAY,
        );
      } else {
        this.log.error(`AiDot cloud sync failed permanently: ${err.message}`);
      }
    });
  }

  private async syncCloudDevices(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      throw new Error('username/password required in Homebridge config');
    }

    this.cloud = new AiDotCloudClient(
      this.config.username,
      this.config.password,
      this.config.countryCode || 'US',
    );
    await this.cloud.login();
    const cloudDevices = await this.cloud.getDevices();

    for (const cloudDevice of cloudDevices) {
      if (!cloudDevice.id) {
        continue;
      }

      const accessory = this.findAccessory(cloudDevice.id);
      const device: AidotDevice = {
        devId: cloudDevice.id,
        ip: accessory?.context.device?.ip || '',
        mac: cloudDevice.mac || '',
        productModel: cloudDevice.modelId || cloudDevice.product?.modelId || 'WiFi Light',
        bindFlag: 1,
        version: 1,
        wifiMode: 0,
        aesKey: normalizeCloudAesKey(cloudDevice.aesKey),
        password: cloudDevice.password || this.config.password,
        name: cloudDevice.name || `AiDot Light ${cloudDevice.id.slice(0, 6)}`,
        userId: this.cloud.getUserId() || this.config.userId || this.config.username,
        firmwareVersion: cloudDevice.firmwareVersion,
      };

      if (accessory) {
        accessory.context.device = device;
        accessory.context.lastSeen = Date.now();
        accessory.updateDisplayName(device.name);
        this.api.updatePlatformAccessories([accessory]);
        this.configureAccessoryServices(accessory);
        this.ensureClient(device, accessory);
      } else {
        this.addAccessory(device);
      }
    }

    if (this.config.removeStaleDevices) {
      this.removeStaleAccessories(cloudDevices.map((d) => d.id));
    }
  }

  // Remove cached accessories for devices no longer in the AiDot account.
  // Only called after a successful full cloud sync, so a transient cloud
  // outage can never wipe accessories.
  private removeStaleAccessories(cloudDeviceIds: string[]): void {
    const validUuids = new Set(
      cloudDeviceIds.filter(Boolean).map((id) => this.api.hap.uuid.generate(id)),
    );
    const stale = this.accessories.filter((a) => !validUuids.has(a.UUID));
    for (const accessory of stale) {
      this.log.info(`Removing stale accessory no longer in AiDot account: ${accessory.displayName}`);
      const devId = (accessory.context.device as AidotDevice | undefined)?.devId;
      if (devId) {
        const client = this.deviceClients.get(devId);
        client?.close().catch(() => {});
        this.deviceClients.delete(devId);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.initializedAccessories.delete(accessory.UUID);
      const idx = this.accessories.indexOf(accessory);
      if (idx >= 0) {
        this.accessories.splice(idx, 1);
      }
    }
  }

  private onDeviceFound(devId: string, ip: string, userId: string): void {
    const accessory = this.findAccessory(devId);
    const device: AidotDevice = accessory?.context.device ?? {
      devId,
      ip,
      mac: '',
      productModel: 'LK.light.A000108',
      bindFlag: 1,
      version: 1,
      wifiMode: 0,
      aesKey: '',
      password: this.config.password || '',
      name: `AiDot Light ${devId.slice(0, 6)}`,
      userId,
    };

    device.ip = ip;

    if (accessory) {
      accessory.context.device = device;
      accessory.context.lastSeen = Date.now();
      accessory.updateDisplayName(device.name);
      this.api.updatePlatformAccessories([accessory]);
      this.configureAccessoryServices(accessory);
    } else {
      this.addAccessory(device);
      return;
    }

    this.ensureClient(device, accessory);
  }

  private findAccessory(devId: string): PlatformAccessory | undefined {
    const uuid = this.api.hap.uuid.generate(devId);
    return this.accessories.find((accessory) => accessory.UUID === uuid);
  }

  private addAccessory(device: AidotDevice): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(device.devId);
    const accessory = new this.api.platformAccessory(
      device.name,
      uuid,
      this.api.hap.Categories.LIGHTBULB,
    );

    accessory.context.device = device;
    accessory.context.lastSeen = Date.now();
    this.configureAccessoryServices(accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.push(accessory);
    this.ensureClient(device, accessory);
    return accessory;
  }

  private ensureClient(device: AidotDevice, accessory: PlatformAccessory): void {
    let client = this.deviceClients.get(device.devId);
    if (!client) {
      client = new AidotDeviceClient(device);
      this.deviceClients.set(device.devId, client);
    } else {
      client.updateDevice(device);
    }

    if (!this.initializedAccessories.has(accessory.UUID)) {
      new AidotLightAccessory(this.log, accessory, this.api, client);
      this.initializedAccessories.add(accessory.UUID);
    }

    if (!device.ip || !device.aesKey || !device.password) {
      return;
    }

    client.connect(device.ip).then(() => {
      this.log.info(`Connected to ${accessory.displayName} at ${device.ip}`);
    }).catch((err) => {
      this.log.warn(`Failed to connect to ${accessory.displayName}: ${err.message}`);
    });
  }

  private configureAccessoryServices(accessory: PlatformAccessory): void {
    const device = accessory.context.device as AidotDevice | undefined;
    if (!device) {
      return;
    }

    const info = accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'AiDot')
      .setCharacteristic(this.Characteristic.Model, device.productModel || 'WiFi Light')
      .setCharacteristic(this.Characteristic.SerialNumber, device.devId.slice(0, 16));
    if (device.firmwareVersion) {
      info.setCharacteristic(this.Characteristic.FirmwareRevision, device.firmwareVersion);
    }

    let service = accessory.getService(this.Service.Lightbulb);
    if (!service) {
      service = accessory.addService(this.Service.Lightbulb, accessory.displayName);
    }

    service.getCharacteristic(this.Characteristic.On);
    service.getCharacteristic(this.Characteristic.Brightness);
    service.getCharacteristic(this.Characteristic.Hue);
    service.getCharacteristic(this.Characteristic.Saturation);
    service.getCharacteristic(this.Characteristic.ColorTemperature)
      .setProps({ minValue: 154, maxValue: 370, minStep: 1 });
  }
}
