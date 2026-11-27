import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';

const rootDir = process.cwd();
const buildDir = resolve(rootDir, 'build');
const cacheDir = resolve(rootDir, '.cache/node-sea');
const bundlePath = resolve(buildDir, 'klared.mjs');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const requestedTarget =
  targetIdx >= 0 ? (args[targetIdx + 1] ?? 'all').toLowerCase() : 'all';

const targets =
  requestedTarget === 'linux'
    ? ['linux']
    : requestedTarget === 'win' || requestedTarget === 'windows'
      ? ['win']
      : ['linux', 'win'];

mkdirSync(buildDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

console.log('1/3 Empaquetando bundle ESM con esbuild...');
await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/index.tsx')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: bundlePath,
  minify: true,
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url || process.execPath);',
    ].join('\n'),
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    "process.env['DEV']": '"false"',
    'process.env.DEV': '"false"',
  },
  plugins: [
    {
      name: 'ignore-ink-devtools',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'ignore-devtools',
        }));
        build.onResolve({ filter: /^\.\/devtools\.js$/ }, () => ({
          path: 'ink-devtools',
          namespace: 'ignore-devtools',
        }));
        build.onLoad({ filter: /.*/, namespace: 'ignore-devtools' }, () => ({
          contents: 'export default {}; export function connectToDevTools() {}',
          loader: 'js',
        }));
      },
    },
  ],
});

function ensureWindowsNodeExe() {
  const version = process.version;
  const folderName = `node-${version}-win-x64`;
  const zipPath = resolve(cacheDir, `${folderName}.zip`);
  const extractedExe = resolve(cacheDir, folderName, 'node.exe');

  if (existsSync(extractedExe)) {
    console.log(`   Usando node.exe en caché (${version})`);
    return extractedExe;
  }

  const url = `https://nodejs.org/dist/${version}/${folderName}.zip`;
  console.log(`   Descargando Node.js Windows x64 (${version}) desde nodejs.org...`);
  execFileSync('curl', ['-fSL', '--retry', '3', '-o', zipPath, url], {
    stdio: 'inherit',
  });

  console.log('   Extrayendo node.exe...');
  execFileSync('unzip', ['-qo', zipPath, `${folderName}/node.exe`, '-d', cacheDir], {
    stdio: 'inherit',
  });

  if (!existsSync(extractedExe)) {
    throw new Error(`No se encontró ${extractedExe} tras descomprimir ${zipPath}`);
  }
  return extractedExe;
}

function formatSizeMb(filePath) {
  const bytes = statSync(filePath).size;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildSeaTarget(target) {
  const isWin = target === 'win';
  const outputBinary = resolve(
    buildDir,
    isWin ? 'klared-win-x64.exe' : 'klared-linux-x64',
  );
  const seaConfigPath = resolve(buildDir, `sea-config-${target}.json`);
  const executable = isWin ? ensureWindowsNodeExe() : process.execPath;

  const seaConfig = {
    main: bundlePath,
    mainFormat: 'module',
    executable,
    output: outputBinary,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };

  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2), 'utf8');

  console.log(
    `\nGenerando ejecutable autocontenido para ${isWin ? 'Windows x64' : 'Linux x64'}...`,
  );
  execFileSync(process.execPath, ['--build-sea', seaConfigPath], {
    stdio: 'inherit',
  });

  if (!isWin) {
    chmodSync(outputBinary, 0o755);
  }

  console.log(`✓ Generado: ${outputBinary} (${formatSizeMb(outputBinary)})`);
}

console.log(`2/3 Construyendo ejecutables SEA (${targets.join(', ')})...`);
for (const target of targets) {
  buildSeaTarget(target);
}

console.log('\n3/3 Build SEA completado.');
