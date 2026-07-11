import {
  API,
  CharacteristicValue,
  PlatformAccessory,
  Logging,
  Service,
} from 'homebridge';
import { AidotDevice, AidotDeviceClient, DeviceStatus } from './protocol';

// Device supports 2700K-6500K. In HomeKit mireds that is 154 (6500K) to
// 370 (2700K). Advertising a wider range makes the Home app slider snap
// back after every adjustment outside what the bulb can do.
const MIN_MIRED = 154;
const MAX_MIRED = 370;

export class AidotLightAccessory {
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
  private colorTemperature = MIN_MIRED;

  // Track last mode: 'color' or 'temperature'
  private colorMode: 'color' | 'temperature' = 'temperature';

  // HomeKit sends Hue and Saturation as separate writes; coalesce them into
  // a single RGBW command instead of hitting the device twice.
  private colorSendTimer: NodeJS.Timeout | null = null;
  private colorSendWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(log: Logging, accessory: PlatformAccessory, api: API, client: AidotDeviceClient) {
    this.log = log;
    this.accessory = accessory;
    this.api = api;
    this.client = client;

    const device = accessory.context.device as AidotDevice | undefined;

    // Accessory Information
    this.informationService = accessory.getService(api.hap.Service.AccessoryInformation) ??
      accessory.addService(api.hap.Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(api.hap.Characteristic.Manufacturer, 'AiDot')
      .setCharacteristic(api.hap.Characteristic.Model, device?.productModel || 'WiFi Light')
      .setCharacteristic(api.hap.Characteristic.SerialNumber, client.getDeviceId().slice(0, 16))
      .setCharacteristic(api.hap.Characteristic.FirmwareRevision, device?.firmwareVersion || '1.0.0');

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

    // Color Temperature
    this.lightService.getCharacteristic(api.hap.Characteristic.ColorTemperature)
      .setProps({ minValue: MIN_MIRED, maxValue: MAX_MIRED, minStep: 1 })
      .onGet(() => this.getColorTemperature())
      .onSet((v) => this.setColorTemperature(v));

    // Adaptive Lighting: lets the Home app shift white temperature through
    // the day. AUTOMATIC mode is fully managed by HAP-NodeJS — it drives our
    // ColorTemperature setter and disables itself when the user picks a color.
    try {
      const controller = new api.hap.AdaptiveLightingController(this.lightService, {
        controllerMode: api.hap.AdaptiveLightingControllerMode.AUTOMATIC,
      });
      accessory.configureController(controller);
    } catch (e) {
      this.log.debug(`[${accessory.displayName}] Adaptive Lighting unavailable: ${(e as Error).message}`);
    }

    // Listen for device status updates
    client.onStatusUpdate((_devId, status) => this.onDeviceStatus(status));

    const status = client.getStatus();
    if (status.online) {
      this.onDeviceStatus(status);
    }
  }

  // Surface offline devices as "No Response" in the Home app instead of
  // silently returning stale cached state.
  private assertOnline(): void {
    if (!this.client.isOnline()) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private commError(): Error {
    return new this.api.hap.HapStatusError(
      this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  // --- Getters ---
  getOn(): CharacteristicValue {
    this.assertOnline();
    return this.isOn;
  }

  getBrightness(): CharacteristicValue {
    this.assertOnline();
    return this.brightness;
  }

  getHue(): CharacteristicValue {
    this.assertOnline();
    return this.hue;
  }

  getSaturation(): CharacteristicValue {
    this.assertOnline();
    return this.saturation;
  }

  getColorTemperature(): CharacteristicValue {
    this.assertOnline();
    return this.colorTemperature;
  }

  // --- Setters ---
  async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.log.info(`[${this.accessory.displayName}] Setting ${on ? 'ON' : 'OFF'}`);
    try {
      if (on) {
        await this.client.turnOn();
      } else {
        await this.client.turnOff();
      }
      this.isOn = on;
    } catch (e) {
      this.log.error(`[${this.accessory.displayName}] Turn ${on ? 'on' : 'off'} failed: ${(e as Error).message}`);
      throw this.commError();
    }
  }

  async setBrightness(value: CharacteristicValue): Promise<void> {
    const brightness = value as number;
    this.log.info(`[${this.accessory.displayName}] Brightness: ${brightness}%`);
    try {
      await this.client.setBrightness(brightness);
      this.brightness = brightness;
    } catch (e) {
      this.log.error(`[${this.accessory.displayName}] Brightness failed: ${(e as Error).message}`);
      throw this.commError();
    }
  }

  async setHue(value: CharacteristicValue): Promise<void> {
    this.hue = value as number;
    this.colorMode = 'color';
    return this.queueColorSend();
  }

  async setSaturation(value: CharacteristicValue): Promise<void> {
    this.saturation = value as number;
    this.colorMode = 'color';
    return this.queueColorSend();
  }

  async setColorTemperature(value: CharacteristicValue): Promise<void> {
    const mired = value as number;
    this.colorMode = 'temperature';
    // Convert mired to Kelvin: K = 1_000_000 / mired
    const kelvin = Math.round(1_000_000 / mired);
    const clamped = Math.max(2700, Math.min(6500, kelvin));
    this.log.info(`[${this.accessory.displayName}] Color Temp: ${mired} mired (${clamped}K)`);
    try {
      await this.client.setCCT(clamped);
      this.colorTemperature = mired;
    } catch (e) {
      this.log.error(`[${this.accessory.displayName}] CCT failed: ${(e as Error).message}`);
      throw this.commError();
    }
  }

  // --- Internal ---
  private queueColorSend(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.colorSendWaiters.push({ resolve, reject });
      if (this.colorSendTimer) {
        clearTimeout(this.colorSendTimer);
      }
      this.colorSendTimer = setTimeout(() => {
        this.colorSendTimer = null;
        const waiters = this.colorSendWaiters;
        this.colorSendWaiters = [];
        const rgb = hsvToRgb(this.hue, this.saturation, this.brightness);
        this.log.info(`[${this.accessory.displayName}] Color: hue=${this.hue} sat=${this.saturation} -> RGBW(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
        this.client.setRGBW(rgb.r, rgb.g, rgb.b, 0).then(
          () => waiters.forEach((w) => w.resolve()),
          (e) => {
            this.log.error(`[${this.accessory.displayName}] RGBW failed: ${(e as Error).message}`);
            waiters.forEach((w) => w.reject(this.commError()));
          },
        );
      }, 50);
    });
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
      const clamped = Math.max(MIN_MIRED, Math.min(MAX_MIRED, mired));
      if (this.colorTemperature !== clamped) {
        this.colorTemperature = clamped;
        this.lightService.updateCharacteristic(this.api.hap.Characteristic.ColorTemperature, this.colorTemperature);
      }
    }
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
