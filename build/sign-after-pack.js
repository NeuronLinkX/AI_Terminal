'use strict';
// electron-builder `afterPack` hook: signs the app with a STABLE identity.
//
// Why: macOS keeps per-app permissions (local network, Keychain "Always Allow" ...) bound to the app's code identity. An ad-hoc
// signature ("-") is different for every build, so every rebuilt or updated app is a stranger and loses its permissions. A signature
// made with the same certificate every time keeps the identity (designated requirement: identifier + certificate hash).
//
// The certificate is created once on the building Mac with scripts/make-signing-cert.sh (docs/SIGNING.md). It does not need to be
// "trusted" by macOS for this: codesign signs with it anyway and macOS only compares the identity. If it is not there the app is
// signed ad-hoc exactly as before, and the build says so.
//   AIT_SIGN_IDENTITY   name of the certificate (default: "MacAIterm Local Signing")
//   AIT_SIGN_KEYCHAIN   look in this keychain instead of the default search list (used by checks)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { signAsync } = require('@electron/osx-sign');
const { patchFile } = require('./macho-uuid');

const DEFAULT_NAME = 'MacAIterm Local Signing';
const ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.plist');

/** Is there a code signing identity with exactly this name? (trusted or not: `find-identity` without -v lists both) */
function haveIdentity(name, keychain) {
  try {
    const out = execFileSync('security', ['find-identity', '-p', 'codesigning', ...(keychain ? [keychain] : [])], { encoding: 'utf8' });
    return out.split('\n').some((l) => l.includes(`"${name}"`) && !/REVOKED|EXPIRED/.test(l));
  } catch { return false; }
}

exports.haveIdentity = haveIdentity;
exports.default = async function signAfterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const wanted = process.env.AIT_SIGN_IDENTITY || DEFAULT_NAME;
  const keychain = process.env.AIT_SIGN_KEYCHAIN || undefined;
  const stable = haveIdentity(wanted, keychain);
  // 0) the app's executables get UUIDs of their own (build/macho-uuid.js: why macOS needs this for the local network question)
  const appId = context.packager.appInfo.id;
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  const exes = [path.join(app, 'Contents', 'MacOS', context.packager.appInfo.productFilename)];
  for (const n of fs.existsSync(frameworks) ? fs.readdirSync(frameworks) : []) if (/ Helper.*\.app$/.test(n)) exes.push(path.join(frameworks, n, 'Contents', 'MacOS', n.replace(/\.app$/, '')));
  let patched = 0;
  for (const f of exes) if (fs.existsSync(f)) patched += patchFile(f, `${appId}|${path.relative(app, f)}`).length;
  console.log(`  • own binary UUIDs: ${patched} executable(s) of ${appId}`);
  // 1) everything inside the app (helpers, frameworks) is signed ad-hoc: quick, and the inner pieces never decide what macOS grants
  // timestamp 'none': a time stamp from Apple's server is only for notarization, and would make an offline build hang
  const every = () => ({ entitlements: ENTITLEMENTS, hardenedRuntime: true, timestamp: 'none' }); // the same rights for every piece
  await signAsync({ app, identity: '-', identityValidation: false, platform: 'darwin', optionsForFile: every });
  if (!stable) {
    console.log(`  • signed ad-hoc: there is no "${wanted}" identity in the keychain, so macOS sees every build as a NEW app (see docs/SIGNING.md)`);
    return;
  }
  // 2) the app itself (the bundle macOS identifies the app by) is signed again with the stable certificate. Not --deep: the inner
  // pieces keep their valid ad-hoc signatures, which keeps this step to a few seconds.
  execFileSync('codesign', ['--force', '--sign', wanted, '--timestamp=none', '--options', 'runtime', '--entitlements', ENTITLEMENTS, ...(keychain ? ['--keychain', keychain] : []), app], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`  • signed with "${wanted}": a stable identity, macOS permissions survive rebuilds`);
};
