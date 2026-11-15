'use strict';
// fetch-cloudflared.cjs — 下载 cloudflared 到 resources/，构建前执行。
// 运行: node scripts/fetch-cloudflared.cjs
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const RESOURCES = path.join(__dirname, '..', 'resources');

const TARGETS = {
  'win32-x64':   { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', file: 'cloudflared.exe' },
  'darwin-arm64': { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz', file: 'cloudflared.tgz' },
  'darwin-x64':   { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz', file: 'cloudflared.tgz' }
};

const key = process.platform + '-' + process.arch;
const target = TARGETS[key];
if (!target) {
  console.error('unsupported platform/arch: ' + key + ' (supported: ' + Object.keys(TARGETS).join(', ') + ')');
  process.exit(2);
}

fs.mkdirSync(RESOURCES, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (e) => {
      file.close();
      fs.unlinkSync(dest);
      reject(e);
    });
  });
}

async function main() {
  const dest = path.join(RESOURCES, target.file);
  console.log('downloading ' + target.url + ' -> ' + dest);
  await download(target.url, dest);

  if (process.platform === 'darwin') {
    const tgz = dest;
    console.log('extracting ' + tgz);
    execFileSync('tar', ['-xzf', tgz, '-C', RESOURCES], { stdio: 'inherit' });
    fs.unlinkSync(tgz);
    if (fs.existsSync(path.join(RESOURCES, 'cloudflared'))) {
      fs.renameSync(path.join(RESOURCES, 'cloudflared'), path.join(RESOURCES, 'cloudflared-' + process.arch));
    }
    fs.chmodSync(path.join(RESOURCES, 'cloudflared-' + process.arch), 0o755);
  }
  console.log('done');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
