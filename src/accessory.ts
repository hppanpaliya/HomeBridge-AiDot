import {
  AccessoryPlugin,
  API,
  CharacteristicValue,
  PlatformAccessory,
  Logging,
  Service,
} from 'homebridge';
import { AidotDeviceClient, DeviceStatus, unpackRGBW } from './protocol';

export class AidotLightAccessory implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly client: AidotDeviceClient;
  private readonly accessory: PlatformAccessory;

  private readonly informationService: Service;
  private readonly lightService: Service;

  // HomeKit state
  private isOn = false;
  private brightness = 100;
  private hue = 0;
  private saturation = 0;
  private colorTemperature = 153; // mired (6500K)

  // Track last mode: 'color' or 'temperature'
  private colorMode: 'color' | 'temperature' = 'temperature';

  constructor(log: Logging, accessory: PlatformAccessory, api: API, client: AidotDeviceClient) {
    this.log = log;
    this.accessory = accessory;
    this.api = api;
    this.client = client;

    // Accessory Information
    this.informationService = accessory.getService(api.hap.Service.AccessoryInformation) ??
      accessory.addService(api.hap.Service.AccessoryInformation)
      .setCharacteristic(api.hap.Characteristic.Manufacturer, 'AiDot')
      .setCharacteristic(api.hap.Characteristic.Model, 'WiFi Light')
      .setCharacteristic(api.hap.Characteristic.SerialNumber, client.getDeviceId().slice(0, 16))
      .setCharacteristic(api.hap.Characteristic.FirmwareRevision, '1.0.0');

    // Lightbulb Service
    this.lightService = accessory.getService(api.hap.Service.Lightbulb) ??
      accessory.addService(api.hap.Service.Lightbulb, accessory.displayName);

    // On/Off
    this.lightService.getCharacteristic(api.hap.Characteristic.On)
      .onGet(() => this.getOn())
      .onSet((v) => this.setOn(v));

    // Brightness
    this.lightService.getCharacteristic(api.hap.Characteristic.Brightness)
      .onGet(() => this.getBrightness())
      .onSet((v) => this.setBrightness(v));

    // Hue
    this.lightService.getCharacteristic(api.hap.Characteristic.Hue)
      .onGet(() => this.getHue())
      .onSet((v) => this.setHue(v));

    // Saturation
    this.lightService.getCharacteristic(api.hap.Characteristic.Saturation)
      .onGet(() => this.getSaturation())
      .onSet((v) => this.setSaturation(v));

    // Color Temperature (mired: 153 = 6500K, 500 = 2000K)
    this.lightService.getCharacteristic(api.hap.Characteristic.ColorTemperature)
      .setProps({ minValue: 153, maxValue: 500, minStep: 1 })
      .onGet(() => this.getColorTemperature())
      .onSet((v) => this.setColorTemperature(v));

    // Listen for device status updates
    client.onStatusUpdate((_devId, status) => this.onDeviceStatus(status));

    // Load initial state from device
    setTimeout(() => {
      const status = client.getStatus();
      if (status.online) {
        this.onDeviceStatus(status);
      }
    }, 3000);

    accessory.context.initialized = true;
  }

  // --- Getters ---
  getOn(): CharacteristicValue {
    return this.isOn;
  }

  getBrightness(): CharacteristicValue {
    return this.brightness;
  }

  getHue(): CharacteristicValue {
    return this.hue;
  }

  getSaturation(): CharacteristicValue {
    return this.saturation;
  }

  getColorTemperature(): CharacteristicValue {
    return this.colorTemperature;
  }

  // --- Setters ---
  setOn(value: CharacteristicValue): void {
    this.isOn = value as boolean;
    const cmd = this.isOn ? 'ON' : 'OFF';
    this.log.info(`[${this.accessory.displayName}] Setting ${cmd}`);
    if (this.isOn) {
      this.client.turnOn().catch((e) => this.log.error(`Turn on failed: ${e.message}`));
    } else {
      this.client.turnOff().catch((e) => this.log.error(`Turn off failed: ${e.message}`));
    }
  }

  setBrightness(value: CharacteristicValue): void {
    this.brightness = value as number;
    this.log.info(`[${this.accessory.displayName}] Brightness: ${this.brightness}%`);
    this.client.setBrightness(this.brightness).catch((e) => this.log.error(`Brightness failed: ${e.message}`));
  }

  setHue(value: CharacteristicValue): void {
    this.hue = value as number;
    this.colorMode = 'color';
    this.log.info(`[${this.accessory.displayName}] Hue: ${this.hue}`);
    this.sendColor();
  }

  setSaturation(value: CharacteristicValue): void {
    this.saturation = value as number;
    this.colorMode = 'color';
    this.log.info(`[${this.accessory.displayName}] Saturation: ${this.saturation}`);
    this.sendColor();
  }

  setColorTemperature(value: CharacteristicValue): void {
    this.colorTemperature = value as number;
    this.colorMode = 'temperature';
    // Convert mired to Kelvin: K = 1_000_000 / mired
    const kelvin = Math.round(1_000_000 / this.colorTemperature);
    const clamped = Math.max(2700, Math.min(6500, kelvin));
    this.log.info(`[${this.accessory.displayName}] Color Temp: ${this.colorTemperature} mired (${clamped}K)`);
    this.client.setCCT(clamped).catch((e) => this.log.error(`CCT failed: ${e.message}`));
  }

  // --- Internal ---
  private sendColor(): void {
    // Convert HSV to RGBW
    const rgb = hsvToRgb(this.hue, this.saturation, this.brightness);
    this.log.info(`[${this.accessory.displayName}] RGBW: (${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
    this.client.setRGBW(rgb.r, rgb.g, rgb.b, 0).catch((e) => this.log.error(`RGBW failed: ${e.message}`));
  }

  private onDeviceStatus(status: DeviceStatus): void {
    if (!status.online) return;

    // Update on/off
    if (this.isOn !== status.on) {
      this.isOn = status.on;
      this.lightService.updateCharacteristic(this.api.hap.Characteristic.On, this.isOn);
    }

    // Update brightness
    const newBrightness = Math.max(0, Math.min(100, status.brightness));
    if (this.brightness !== newBrightness) {
      this.brightness = newBrightness;
      this.lightService.updateCharacteristic(this.api.hap.Characteristic.Brightness, this.brightness);
    }

    // Update from device RGBW
    const rgbw = status.rgbw;
    if (rgbw.r > 0 || rgbw.g > 0 || rgbw.b > 0) {
      const hsv = rgbToHsv(rgbw.r, rgbw.g, rgbw.b);
      this.hue = hsv.h;
      this.saturation = hsv.s;
      this.lightService.updateCharacteristic(this.api.hap.Characteristic.Hue, this.hue);
      this.lightService.updateCharacteristic(this.api.hap.Characteristic.Saturation, this.saturation);
    }

    // Update from device CCT
    if (status.cct > 0) {
      const mired = Math.round(1_000_000 / status.cct);
      const clamped = Math.max(153, Math.min(500, mired));
      this.colorTemperature = clamped;
      this.lightService.updateCharacteristic(this.api.hap.Characteristic.ColorTemperature, this.colorTemperature);
    }
  }

  getServices(): Service[] {
    return [this.informationService, this.lightService];
  }
}

// --- Color Conversion Helpers ---

function hsvToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  // HomeKit Hue is 0-360, Saturation 0-100, Brightness 0-100
  // We treat as HSV (Hue, Saturation, Value/Brightness)
  const hNorm = h / 360;
  const sNorm = s / 100;
  const vNorm = l / 100;

  let r = 0, g = 0, b = 0;
  const i = Math.floor(hNorm * 6);
  const f = hNorm * 6 - i;
  const p = vNorm * (1 - sNorm);
  const q = vNorm * (1 - f * sNorm);
  const t = vNorm * (1 - (1 - f) * sNorm);

  switch (i % 6) {
    case 0: r = vNorm; g = t; b = p; break;
    case 1: r = q; g = vNorm; b = p; break;
    case 2: r = p; g = vNorm; b = t; break;
    case 3: r = p; g = q; b = vNorm; break;
    case 4: r = t; g = p; b = vNorm; break;
    case 5: r = vNorm; g = p; b = q; break;
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    v: Math.round(v * 100),
  };
}
