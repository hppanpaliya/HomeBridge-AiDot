import { API } from 'homebridge';
import { AiDotPlatform } from './platform';

const PLUGIN_NAME = 'homebridge-aidot';
const PLATFORM_NAME = 'AiDot';

export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AiDotPlatform);
};
