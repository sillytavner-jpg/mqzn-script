import path from 'node:path';
import { pathToFileURL } from 'node:url';
import webpack from 'webpack';

const root = path.resolve(import.meta.dirname, '../../../..');
const configModule = await import(pathToFileURL(path.join(root, 'webpack.config.ts')).href);
const allConfigs = configModule.default.map(factory => factory({}, { mode: 'production' }));
const targetEntry = path.join(root, 'src', '智脑', '源码', 'src', 'index.ts');
const config = allConfigs.find(item => path.resolve(String(item.entry)) === targetEntry);
if (!config) throw new Error(`没有找到智脑构建入口：${targetEntry}`);

const sideEffectPlugins = new Set([
  'watch_tavern_helper',
  'schema_dump',
  'tavern_sync',
  'copy_characters',
]);
config.plugins = (config.plugins ?? []).filter(plugin => !sideEffectPlugins.has(plugin?.apply?.name));
config.output = {
  ...config.output,
  path: path.join(root, 'src', '智脑', '源码', '.build-test'),
  clean: true,
};
config.mode = 'production';
config.cache = false;

const stats = await new Promise((resolve, reject) => {
  const compiler = webpack(config);
  compiler.run((error, result) => {
    compiler.close(closeError => {
      if (error || closeError) reject(error ?? closeError);
      else if (!result) reject(new Error('Webpack 没有返回构建结果'));
      else resolve(result);
    });
  });
});

const output = stats.toString({
  colors: false,
  all: false,
  assets: true,
  errors: true,
  warnings: true,
  timings: true,
});
if (output.trim()) console.log(output);
if (stats.hasErrors()) process.exitCode = 1;
