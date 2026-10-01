/* ----------------------------------------------------------------------------
   把 src/app.js + three.js（含 addons / lil-gui）打包成单文件 HTML
   用法： node build.mjs
   -------------------------------------------------------------------------- */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import esbuild from './.build/node_modules/esbuild/lib/main.js';

const root = path.dirname(fileURLToPath(import.meta.url));

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'app.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'edge100', 'firefox100', 'safari15'],
  platform: 'browser',
  write: false,
  legalComments: 'none',
  charset: 'utf8',
  minify: false,
  nodePaths: [path.join(root, '.build', 'node_modules')],
  logLevel: 'info'
});

const js = result.outputFiles[0].text;
const shell = fs.readFileSync(path.join(root, 'src', 'shell.html'), 'utf8');
const out = shell.replace('/*__APP_BUNDLE__*/', () => js.replace(/<\/script>/gi, '<\\/script>'));

const dest = path.join(root, 'aurora-curtain.html');
fs.writeFileSync(dest, out, 'utf8');
console.log(`[build] ${path.basename(dest)}  ${(out.length / 1024).toFixed(0)} KB`);
