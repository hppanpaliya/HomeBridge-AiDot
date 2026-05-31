# homebridge-aidot

AiDot light plugin for Homebridge.

## Features

- On / off
- Brightness
- RGBW color
- Color temperature
- Cloud device sync + LAN control

## Install

```bash
npm install
npm run build
npm publish --access public
```

## Homebridge config

```json
{
  "platform": "AiDot",
  "name": "AiDot Lights",
  "username": "your_aiot_username",
  "password": "your_aiot_password",
  "countryCode": "US"
}
```

## Notes

- Credentials stay in Homebridge config.
- UDP discovery uses port `6666`.
- TCP device control uses port `10000`.
- Supports AiDot light bulbs only.
