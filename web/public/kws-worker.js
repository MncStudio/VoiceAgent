// 服务根由页面通过 Worker name 传入（跨域嵌入时为超宝服务的绝对地址）。
const base = (self.name || '').replace(/\/+$/, '');
let spotter,
  stream,
  ready = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      importScripts(
        `${base}/models/kws/sherpa-onnx-kws.js`,
        `${base}/models/kws/sherpa-onnx-wasm-web.js`,
      );
      const Module = await SherpaOnnx({
        locateFile: (name) => `${base}/models/kws/${name}`,
        print() {},
        printErr() {},
      });
      const files = [
        'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
        'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
        'tokens.txt',
      ];
      await Promise.all(
        files.map(async (name) => {
          const response = await fetch(`${base}/models/kws/${name}`);
          if (!response.ok) throw new Error('模型文件缺失');
          Module.FS.writeFile(`/${name}`, new Uint8Array(await response.arrayBuffer()));
        }),
      );
      const keywords = data.keywords;
      spotter = createKws(Module, {
        featConfig: { samplingRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: `/${files[0]}`, decoder: `/${files[1]}`, joiner: `/${files[2]}` },
          tokens: '/tokens.txt',
          provider: 'cpu',
          numThreads: 1,
          debug: 0,
          modelingUnit: 'cjkchar',
          bpeVocab: '',
        },
        maxActivePaths: 4,
        numTrailingBlanks: 1,
        keywordsScore: 1.5,
        keywordsThreshold: 0.25,
        keywords: '',
        keywordsBuf: keywords,
        keywordsBufSize: new TextEncoder().encode(keywords).length,
      });
      if (!spotter.handle) throw new Error('唤醒模型初始化失败');
      stream = spotter.createStream();
      ready = true;
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error) });
    }
  }
  if (data.type === 'audio' && ready) {
    try {
      stream.acceptWaveform(16000, data.pcm);
      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (result.keyword) {
          self.postMessage({ type: 'keyword', keyword: result.keyword });
          spotter.reset(stream);
        }
      }
    } catch {
      self.postMessage({ type: 'error', message: '唤醒模型推理失败' });
      ready = false;
    }
  }
};
