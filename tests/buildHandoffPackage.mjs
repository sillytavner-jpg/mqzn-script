import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../../../..');
const zhinaoRoot = path.join(projectRoot, 'src', '智脑');
const outputRoot = path.join(zhinaoRoot, '交接包-2026-07-25');
const expectedOutputRoot = path.resolve(zhinaoRoot, '交接包-2026-07-25');

if (path.resolve(outputRoot) !== expectedOutputRoot || path.dirname(outputRoot) !== path.resolve(zhinaoRoot)) {
  throw new Error(`拒绝清理非预期交接目录：${outputRoot}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const buildDir = path.join(zhinaoRoot, '源码', '.build-test');
const buildFile = path.join(buildDir, 'index.js');
const buildMap = path.join(buildDir, 'index.js.map');
const baselineJsonPath = path.join(zhinaoRoot, '明月秋青脚本-秋青A5.1.0.json');

const buildContent = await readFile(buildFile, 'utf8');
const baselineScript = JSON.parse(await readFile(baselineJsonPath, 'utf8'));
const handoffScript = {
  ...baselineScript,
  name: '明月秋青脚本-秋青A5.1.0-记忆重构Final-A-20260725',
  content: buildContent,
};

await writeFile(
  path.join(outputRoot, '明月秋青脚本-当前交接版-20260725.json'),
  `${JSON.stringify(handoffScript)}\n`,
  'utf8',
);

await mkdir(path.join(outputRoot, '生产构建'), { recursive: true });
await cp(buildFile, path.join(outputRoot, '生产构建', 'index.js'));
await cp(buildMap, path.join(outputRoot, '生产构建', 'index.js.map'));

await mkdir(path.join(outputRoot, '源码'), { recursive: true });
await cp(path.join(zhinaoRoot, '源码', 'src'), path.join(outputRoot, '源码', 'src'), { recursive: true });
await cp(path.join(zhinaoRoot, '源码', 'tests'), path.join(outputRoot, '源码', 'tests'), { recursive: true });
await cp(
  path.join(zhinaoRoot, '源码', 'tsconfig.memory-warehouse.json'),
  path.join(outputRoot, '源码', 'tsconfig.memory-warehouse.json'),
);

const handoffDocs = [
  '项目交接清单-2026-07-25.md',
  '重构任务清单-记忆仓V1.md',
  '记忆仓V1-设计说明.md',
  '现有记忆功能逐项去留评审-2026-07-17.md',
  '运行约束与上下文工程基线-2026-07-17.md',
  '正式脚本本地注入说明.md',
  '更新说明-A5.1.0.md',
  '明月秋青脚本-秋青A5.1.0.json',
];

await mkdir(path.join(outputRoot, '文档与基线'), { recursive: true });
for (const filename of handoffDocs) {
  await cp(path.join(zhinaoRoot, filename), path.join(outputRoot, '文档与基线', filename));
}
await cp(
  path.join(zhinaoRoot, '项目交接清单-2026-07-25.md'),
  path.join(outputRoot, '先读-项目交接清单.md'),
);

const packageManifest = {
  packageName: '智脑-记忆重构-Final-A-交接包-20260725',
  createdAt: new Date().toISOString(),
  baseline: '明月秋青脚本-秋青A5.1.0',
  buildMark: 'context-fold-final-a-20260717',
  runtimeDebugApiVersion: 3,
  memoryWarehouseSchemaVersion: 2,
  validation: {
    memoryWarehouseTests: '12/12 passed',
    typescript: 'passed',
    finalACoreEslint: '0 errors, 0 warnings',
    productionBuild: 'passed with webpack size warnings',
    realSillyTavernFinalAEventRegression: 'pending',
  },
  promptFilesChangedByFinalA: false,
};
await writeFile(
  path.join(outputRoot, 'package-manifest.json'),
  `${JSON.stringify(packageManifest, null, 2)}\n`,
  'utf8',
);

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}

const packagedFiles = (await listFiles(outputRoot))
  .filter(file => path.basename(file) !== 'SHA256SUMS.txt')
  .sort((left, right) => left.localeCompare(right, 'zh-CN'));
const hashLines = [];
for (const file of packagedFiles) {
  const data = await readFile(file);
  const digest = createHash('sha256').update(data).digest('hex');
  const relativePath = path.relative(outputRoot, file).replaceAll(path.sep, '/');
  hashLines.push(`${digest}  ${relativePath}`);
}
await writeFile(path.join(outputRoot, 'SHA256SUMS.txt'), `${hashLines.join('\n')}\n`, 'utf8');

const importJsonStat = await stat(path.join(outputRoot, '明月秋青脚本-当前交接版-20260725.json'));
const buildStat = await stat(path.join(outputRoot, '生产构建', 'index.js'));
console.log(JSON.stringify({
  outputRoot,
  fileCount: packagedFiles.length + 1,
  importJsonBytes: importJsonStat.size,
  buildBytes: buildStat.size,
}, null, 2));
