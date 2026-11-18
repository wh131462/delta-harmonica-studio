/**
 * electron-builder afterPack 钩子（仅 macOS 生效）。
 *
 * Apple Silicon 要求应用至少带 ad-hoc 签名，否则双击会提示「已损坏」。
 * CI / 本地没有 Developer ID 证书时，electron-builder 会跳过签名，这里补一次 ad-hoc 签名；
 * 配置了正式证书（CSC_LINK / CSC_NAME）时不介入，交给 electron-builder 正常签名与公证。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  if (result.error) {
    console.warn(`[after-pack] 无法执行 codesign：${result.error.message}`);
  } else if (result.status !== 0) {
    console.warn('[after-pack] ad-hoc 签名失败；产物可能需要在终端执行 `xattr -cr <app>` 后才能打开');
  } else {
    console.log(`[after-pack] 已完成 ad-hoc 签名：${appPath}`);
  }
};
