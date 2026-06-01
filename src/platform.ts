import {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { loadDotEnv } from './env';
import { AiDotCloudClient } from './aidot-cloud';
import { AidotDiscovery, AidotDevice, AidotDeviceClient } from './protocol';
import { AidotLightAccessory } from './accessory';

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
  private cloud: AiDotCloudClient | null = null;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    loadDotEnv();
    this.log = log;
    this.config = config as AiDotPlatformConfig;
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.startDiscovery();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.push(accessory);
    this.configureAccessoryServices(accessory);
  }

  private startDiscovery(): void {
    const userId = this.config.userId || this.config.username || '0';
    this.discovery = new AidotDiscovery(userId, (devId, ip) => {
      this.onDeviceFound(devId, ip, userId);
    });
    this.discovery.start();
    this.log.info('AiDot LAN discovery started');

    this.syncCloudDevices().catch((err) => {
      this.log.warn(`AiDot cloud sync failed: ${err.message}`);
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
      };

      if (accessory) {
        accessory.context.device = device;
        accessory.context.lastSeen = Date.now();
        accessory.updateDisplayName(device.name);
        this.api.updatePlatformAccessories([accessory]);
        this.configureAccessoryServices(accessory);
        if (device.ip) {
          this.ensureClient(device, accessory);
        }
      } else {
        const created = this.addAccessory(device);
        if (device.ip) {
          this.ensureClient(device, created);
        }
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

    if (!accessory.context.initialized) {
      new AidotLightAccessory(this.log, accessory, this.api, client);
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

    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'AiDot')
      .setCharacteristic(this.Characteristic.Model, device.productModel || 'WiFi Light')
      .setCharacteristic(this.Characteristic.SerialNumber, device.devId.slice(0, 16));

    let service = accessory.getService(this.Service.Lightbulb);
    if (!service) {
      service = accessory.addService(this.Service.Lightbulb, accessory.displayName);
    }

    service.getCharacteristic(this.Characteristic.On);
    service.getCharacteristic(this.Characteristic.Brightness);
    service.getCharacteristic(this.Characteristic.Hue);
    service.getCharacteristic(this.Characteristic.Saturation);
    service.getCharacteristic(this.Characteristic.ColorTemperature)
      .setProps({ minValue: 153, maxValue: 500, minStep: 1 });
  }
}
