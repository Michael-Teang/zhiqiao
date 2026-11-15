'use strict';
// pack-win.cjs — 打包 Windows 绿色版到 dist/。
// 运行: node scripts/pack-win.cjs
const packager = require('@electron/packager');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');

function requireCloudflared() {
  const p = path.join(root, 'resources', 'cloudflared.exe');
  if (!fs.existsSync(p)) {
    console.error('缺少 resources/cloudflared.exe，先运行: npm run fetch:cloudflared');
    process.exit(2);
  }
}

async function main() {
  requireCloudflared();
  const appPaths = await packager({
    dir: root,
    out: path.join(root, 'dist'),
    name: '智桥-zhiqiao',
    platform: 'win32',
    arch: 'x64',
    electronVersion: '38.2.1',
    asar: true,
    prune: true,
    overwrite: true,
    icon: path.join(root, 'assets', 'icon.ico'),
    ignore: [
      /^\/dist/,
      /^\/\.git/,
      /^\/node_modules\/\.cache/
    ],
    afterCopy: [(buildPath) => {
      const dest = path.join(buildPath, 'resources', 'cloudflared.exe');
      fs.copyFileSync(path.join(root, 'resources', 'cloudflared.exe'), dest);
      fs.writeFileSync(path.join(buildPath, '使用说明.txt'), fs.readFileSync(path.join(root, 'docs', '使用说明-win.txt'), 'utf8'));
    }]
  });
  console.log('packed: ' + appPaths.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
