import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
if (
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY
)
  setGlobalDispatcher(new EnvHttpProxyAgent());
const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
export const speechProxy = proxy ? new HttpsProxyAgent(proxy) : undefined;
