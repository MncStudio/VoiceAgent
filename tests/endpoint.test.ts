import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceRoot, serviceUrl, setServiceBase, socketUrl } from '../web/src/endpoint';

describe('SDK 服务地址', () => {
  afterEach(() => {
    setServiceBase('');
    vi.unstubAllGlobals();
  });
  const at = (href: string) => vi.stubGlobal('location', new URL(href));
  it('缺省同源，保持相对路径', () => {
    at('https://coal.example.com/screen');
    setServiceBase('');
    expect(serviceUrl('/api/config')).toBe('/api/config');
    expect(serviceRoot()).toBe('https://coal.example.com');
    expect(socketUrl('/control?session=1')).toBe('wss://coal.example.com/control?session=1');
  });
  it('反向代理前缀', () => {
    at('http://localhost/index');
    setServiceBase('/chaobao/');
    expect(serviceUrl('/models/kws/tokens.txt')).toBe(
      'http://localhost/chaobao/models/kws/tokens.txt',
    );
    expect(socketUrl('/control?session=1')).toBe('ws://localhost/chaobao/control?session=1');
  });
  it('跨域独立部署', () => {
    at('https://coal.example.com/');
    setServiceBase('https://chaobao.example.com');
    expect(serviceUrl('/api/sessions')).toBe('https://chaobao.example.com/api/sessions');
    expect(socketUrl('/control?session=1')).toBe('wss://chaobao.example.com/control?session=1');
  });
});
