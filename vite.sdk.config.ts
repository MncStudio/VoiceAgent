import { defaultClientConditions, defineConfig } from 'vite';
// 超宝 SDK：ES 模块，由超宝服务在 /sdk/chaobao-sdk.js 提供，宿主页面运行时动态 import。
// 模型、Worker 与 AudioWorklet 不打进包里，运行时按 baseUrl 从超宝服务加载。
export default defineConfig({
  publicDir: false,
  // 使用 ONNX Runtime 的“外置 wasm”入口：wasm 运行时从 /vendor/ort/ 加载，不以 base64 打进 SDK。
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  build: {
    outDir: 'dist/sdk',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: 'web/src/sdk.ts',
      formats: ['es'],
      fileName: () => 'chaobao-sdk.js',
    },
    rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
  },
});
