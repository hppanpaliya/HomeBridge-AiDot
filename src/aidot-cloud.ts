import * as crypto from 'crypto';

const APP_ID = '1383974540041977857';
const API_URL_TEMPLATE = 'https://prod-{region}-api.arnoo.com/v17';
const DEFAULT_REGION = 'us';
const PUBLIC_KEY_PEM = `
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCtQAnPCi8ksPnS1Du6z96PsKfN
p2Gp/f/bHwlrAdplbX3p7/TnGpnbJGkLq8uRxf6cw+vOthTsZjkPCF7CatRvRnTj
c9fcy7yE0oXa5TloYyXD6GkxgftBbN/movkJJGQCc7gFavuYoAdTRBOyQoXBtm0m
kXMSjXOldI/290b9BQIDAQAB
-----END PUBLIC KEY-----
`;

export interface AiDotCloudDevice {
  id: string;
  name: string;
  mac?: string;
  type?: string;
  modelId?: string;
  productId?: string;
  houseId?: string;
  roomId?: string;
  online?: boolean;
  firmwareVersion?: string;
  hardwareVersion?: string;
  protocolVersion?: string;
  aesKey?: string[];
  password?: string;
  simpleVersion?: string;
  product?: {
    id?: string;
    name?: string;
    modelId?: string;
    serviceModules?: Array<{
      identity?: string;
      properties?: Array<{ minValue?: number; maxValue?: number }>;
    }>;
  } | null;
}

interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  id: string;
}

function rsaPasswordEncrypt(message: string): string {
  const publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(message, 'utf8'),
  );
  return encrypted.toString('base64');
}

const REQUEST_TIMEOUT = 15_000;

const COUNTRY_NAMES: Record<string, string> = {
  us: 'United States',
  eu: 'Germany',
  jp: 'Japan',
};

export class AiDotCloudClient {
  private readonly region: string;
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private accessToken = '';
  private refreshToken = '';
  private userId = '';
  private countryName: string;
  private token: LoginResponse | null = null;

  constructor(username: string, password: string, countryCode = 'US') {
    this.username = username;
    this.password = password;
    this.region = countryCode.toLowerCase() === 'eu' ? 'eu' : countryCode.toLowerCase() === 'jp' ? 'jp' : DEFAULT_REGION;
    this.countryName = COUNTRY_NAMES[this.region] || COUNTRY_NAMES.us;
    this.baseUrl = API_URL_TEMPLATE.replace('{region}', this.region);
  }

  getUserId(): string {
    return this.userId;
  }

  async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/users/loginWithFreeVerification`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        Appid: APP_ID,
        Terminal: 'app',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        countryKey: `region:${this.countryName}`,
        username: this.username,
        password: rsaPasswordEncrypt(this.password),
        terminalId: 'homebridge-aidot',
        webVersion: '0.5.0',
        area: 'Asia/Shanghai',
        UTC: 'UTC+8',
      }),
    });

    const data = (await response.json().catch(() => null)) as LoginResponse | null;
    if (!response.ok || !data?.accessToken) {
      throw new Error(`AiDot login failed: ${JSON.stringify(data)}`);
    }

    this.token = data;
    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken || '';
    this.userId = data.id;
  }

  async getDevices(): Promise<AiDotCloudDevice[]> {
    const houses = await this.getJson('/houses');
    const devices: AiDotCloudDevice[] = [];

    for (const house of houses ?? []) {
      if (house?.isOwner === false) {
        continue;
      }
      const houseDevices = await this.getJson(`/devices?houseId=${house.id}`);
      for (const device of houseDevices ?? []) {
        const product = await this.getProduct(device.productId).catch(() => null);
        devices.push({
          ...device,
          product,
        });
      }
    }

    return devices;
  }

  private async getProduct(productId: string): Promise<AiDotCloudDevice['product'] | null> {
    if (!productId) {
      return null;
    }
    const products = await this.getJson(`/products/${productId}`);
    return Array.isArray(products) ? products[0] : products;
  }

  private async getJson(path: string): Promise<any> {
    if (!this.accessToken) {
      throw new Error('AiDot cloud client is not logged in');
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        Appid: APP_ID,
        Terminal: 'app',
        Token: this.accessToken,
      },
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`AiDot request failed ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }
}
