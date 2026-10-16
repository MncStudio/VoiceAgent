/**
 * 超宝服务地址。缺省为同源（相对路径）；作为 SDK 嵌入其他系统时可指向独立部署的超宝服务，
 * 如 https://chaobao.example.com 或经反向代理的 /chaobao。
 * 接口、控制 WebSocket、端侧模型和 Worker 都从这里加载。
 */
let root = '';
export function setServiceBase(url = '') {
  root = url ? new URL(url, location.href).href.replace(/\/+$/u, '') : '';
}
/** 服务端资源地址；同源时保持相对路径。 */
export const serviceUrl = (path: string) => root + path;
/** 绝对地址形式的服务根，供 Worker 等无法解析相对路径的场景使用。 */
export const serviceRoot = () => root || location.origin;
export function socketUrl(path: string) {
  const url = new URL(serviceUrl(path), location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
/**
 * 创建经典 Worker。浏览器不允许直接用跨域脚本创建 Worker，跨域时用同源 Blob 中转后
 * importScripts 加载；服务根通过 Worker name 传入，供 Worker 内拼接模型地址。
 */
export function createWorker(path: string) {
  const url = new URL(serviceUrl(path), location.href);
  const options = { name: serviceRoot() };
  if (url.origin === location.origin) return new Worker(url, options);
  const blob = new Blob([`importScripts(${JSON.stringify(url.href)});`], {
    type: 'text/javascript',
  });
  const href = URL.createObjectURL(blob);
  const worker = new Worker(href, options);
  setTimeout(() => URL.revokeObjectURL(href), 10000);
  return worker;
}
