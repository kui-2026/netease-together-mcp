import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import apiModule from '@neteasecloudmusicapienhanced/api';
import QRCode from 'qrcode';

const api = apiModule?.default ?? apiModule;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function replaceCookie(envText, cookie) {
  const entry = `NETEASE_COOKIE=${cookie}`;
  return /^NETEASE_COOKIE=.*$/m.test(envText)
    ? envText.replace(/^NETEASE_COOKIE=.*$/m, entry)
    : `${envText.trimEnd()}\n${entry}\n`;
}

const keyResult = await api.login_qr_key({ timestamp: Date.now() });
const key = keyResult?.body?.data?.unikey;
if (!key) throw new Error('Could not create a NetEase QR login key.');

const qrResult = await api.login_qr_create({ key, timestamp: Date.now() });
const qrUrl = qrResult?.body?.data?.qrurl;
if (!qrUrl) throw new Error('Could not create a NetEase QR login code.');

console.log(await QRCode.toString(qrUrl, { type: 'terminal' }));
console.log('请用网易云音乐小号扫码，并在手机上确认登录。二维码约 3 分钟有效。');

const states = {
  800: '二维码已过期，请重新运行本脚本。',
  801: '等待扫码…',
  802: '已扫码，请在手机上确认…',
};

for (let attempt = 0; attempt < 90; attempt += 1) {
  const statusResult = await api.login_qr_check({ key, timestamp: Date.now() });
  const body = statusResult?.body ?? {};
  const code = Number(body.code);

  if (code === 803) {
    const cookie = String(body.cookie ?? '').trim();
    if (!cookie) throw new Error('Login was confirmed, but NetEase returned no cookie.');
    const envText = await readFile('.env', 'utf8');
    await writeFile('.env', replaceCookie(envText, cookie), 'utf8');
    console.log('云端小号登录成功，Cookie 已仅保存在这台服务器的 .env 中。');
    process.exit(0);
  }

  console.log(states[code] ?? `登录状态：${code || '未知'}。`);
  if (code === 800) process.exit(1);
  await pause(2000);
}

throw new Error('等待登录超时，请重新运行本脚本。');
