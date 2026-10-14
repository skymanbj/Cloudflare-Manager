#!/usr/bin/env node
/**
 * Cloudflare Manager 静态校验
 *
 * 检查项：
 *   1. 所有 JS 文件语法（node --check）
 *   2. manifest.json 结构 / manifest_version / 必填字段 / 版本号一致性
 *   3. 图标文件存在且实际尺寸与 manifest 声明的键匹配
 *   4. 危险 API 扫描（unescape / eval / new Function / document.write）
 *   5. popup.html 引用的本地资源是否都存在
 *
 * 用法：npm test
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let errors = 0;
let warnings = 0;

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => { errors++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${msg}`); };
const abs = (p) => path.join(root, p);

// ---------- 1. JS 语法 ----------
// 用 vm.Script 在进程内编译（只编译不执行）来检查语法，
// 避免 execFileSync 在部分 Windows 环境下触发 spawn EBUSY。
console.log('\n[1/5] JS 语法检查');
const jsFiles = [
  'popup.js', 'background.js', 'content.js', 'marked.min.js',
  ...(readdirSync(abs('js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`).sort())
];
for (const f of jsFiles) {
  try {
    new vm.Script(readFileSync(abs(f), 'utf8'), { filename: f });
    ok(f);
  } catch (e) {
    bad(`${f}: ${String(e.message).split('\n')[0]}`);
  }
}

// ---------- 2. manifest.json ----------
console.log('\n[2/5] manifest.json 校验');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(abs('manifest.json'), 'utf8'));
  ok('JSON 可解析');
} catch (e) {
  bad(`manifest.json 解析失败: ${e.message}`);
}

if (manifest) {
  if (manifest.manifest_version === 3) ok('manifest_version = 3');
  else bad(`manifest_version 应为 3，当前为 ${manifest.manifest_version}`);

  for (const key of ['name', 'version', 'description', 'icons', 'permissions']) {
    if (manifest[key] === undefined) bad(`缺少必填字段: ${key}`);
    else ok(`字段 ${key} 存在`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) {
    bad(`version 不符合 semver: ${manifest.version}`);
  } else {
    ok(`version = ${manifest.version}`);
  }

  // 与 package.json 版本号保持一致
  try {
    const pkg = JSON.parse(readFileSync(abs('package.json'), 'utf8'));
    if (pkg.version === manifest.version) ok(`版本号与 package.json 一致 (${pkg.version})`);
    else bad(`版本号不一致: manifest=${manifest.version} package.json=${pkg.version}`);
  } catch {
    warn('package.json 不存在或不可解析，跳过版本一致性检查');
  }

  // 权限最小化提示
  const usedApis = jsFiles.map((f) => readFileSync(abs(f), 'utf8')).join('\n');
  for (const perm of manifest.permissions || []) {
    const usage = {
      scripting: /chrome\.scripting|\bchrome\.scripting\b/.test(usedApis),
      downloads: /chrome\.downloads/.test(usedApis),
      alarms: /chrome\.alarms/.test(usedApis),
      storage: /chrome\.storage/.test(usedApis),
      tabs: /chrome\.tabs/.test(usedApis)
    };
    if (perm in usage && usage[perm] === false) {
      warn(`权限 "${perm}" 在代码中未发现使用迹象，可考虑移除`);
    }
  }
}

// ---------- 3. 图标尺寸 ----------
console.log('\n[3/5] 图标文件与尺寸');
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24) return null;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!b.subarray(0, 8).equals(sig)) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

if (manifest?.icons) {
  for (const [size, rel] of Object.entries(manifest.icons)) {
    if (!existsSync(abs(rel))) { bad(`图标缺失: ${rel}`); continue; }
    const actual = pngSize(abs(rel));
    if (!actual) { bad(`图标不是有效 PNG: ${rel}`); continue; }
    if (actual.width !== Number(size) || actual.height !== Number(size)) {
      bad(`${rel} 声明为 ${size}x${size}，实际为 ${actual.width}x${actual.height}`);
    } else {
      ok(`${rel} = ${actual.width}x${actual.height}`);
    }
  }
}

// ---------- 4. 危险 API ----------
console.log('\n[4/5] 危险 API 扫描');
const risky = [
  [/[^.\w]unescape\s*\(/, 'unescape() 已废弃，应使用 TextEncoder'],
  [/[^.\w]eval\s*\(/, 'eval() 不安全'],
  [/new\s+Function\s*\(/, 'new Function() 不安全'],
  [/document\.write\s*\(/, 'document.write() 会破坏 MV3 CSP']
];
for (const f of jsFiles) {
  const src = readFileSync(abs(f), 'utf8');
  // 去掉注释后再扫描，避免注释里的说明文字误报
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  const lines = code.split('\n');
  let found = false;
  lines.forEach((line, i) => {
    for (const [re, desc] of risky) {
      if (re.test(line)) { bad(`${f}:${i + 1}  ${desc} → ${line.trim().slice(0, 80)}`); found = true; }
    }
  });
  if (!found) ok(`${f} 未发现危险 API`);
}

// ---------- 5. popup.html 资源引用 ----------
console.log('\n[5/5] popup.html 资源引用');
try {
  const html = readFileSync(abs('popup.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u && !/^(https?:|data:|#|mailto:)/.test(u));
  const unique = [...new Set(refs)];
  if (unique.length === 0) warn('未找到本地资源引用');
  for (const ref of unique) {
    if (existsSync(abs(ref.split('?')[0]))) ok(ref);
    else bad(`引用的文件不存在: ${ref}`);
  }
  // 反向检查：js/ 下的模块必须被 popup.html 引用，否则整个模块不会加载
  const jsDir = abs('js');
  if (existsSync(jsDir)) {
    for (const mf of readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort()) {
      if (unique.includes(`js/${mf}`)) ok(`模块已被引用: js/${mf}`);
      else bad(`模块未被 popup.html 引用（不会被加载）: js/${mf}`);
    }
  }
} catch (e) {
  bad(`读取 popup.html 失败: ${e.message}`);
}

// ---------- 5b. importScripts 引用 ----------
console.log('\n[5b] importScripts 引用');
try {
  const sw = readFileSync(abs('background.js'), 'utf8');
  const scripts = [...sw.matchAll(/importScripts\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  if (scripts.length === 0) warn('background.js 未使用 importScripts');
  for (const s of scripts) {
    if (existsSync(abs(s))) ok(`importScripts -> ${s}`);
    else bad(`importScripts 目标不存在: ${s}`);
  }
} catch (e) {
  bad(`读取 background.js 失败: ${e.message}`);
}

// ---------- 5c. popup.html 脚本加载顺序 ----------
// js/ 下的模块以 Object.assign 挂载到 CloudflareManager.prototype，
// 必须晚于 popup.js（类定义）加载，否则初始化时方法尚不存在。
console.log('\n[5c] popup.html 脚本加载顺序');
try {
  const html = readFileSync(abs('popup.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const popupIdx = srcs.indexOf('popup.js');
  if (popupIdx === -1) {
    bad('popup.html 未引用 popup.js');
  } else {
    const jsModules = srcs.filter((s) => s.startsWith('js/') && s !== 'js/github-sync.js');
    const badOrder = jsModules.filter((s) => srcs.indexOf(s) < popupIdx);
    if (badOrder.length > 0) bad(`以下模块必须先于 popup.js 之后加载: ${badOrder.join(', ')}`);
    else ok(`popup.js 之后的模块: ${jsModules.join(', ') || '（无）'}`);
    const gsmIdx = srcs.indexOf('js/github-sync.js');
    if (gsmIdx !== -1 && gsmIdx > popupIdx) bad('js/github-sync.js 必须在 popup.js 之前加载（popup 构造器引用 GitHubSyncManager）');
    else if (gsmIdx !== -1) ok('js/github-sync.js 在 popup.js 之前');
  }
} catch (e) {
  bad(`读取 popup.html 失败: ${e.message}`);
}

// ---------- 汇总 ----------
console.log(`\n${'='.repeat(46)}`);
if (errors > 0) {
  console.log(`\x1b[31m校验失败：${errors} 个错误，${warnings} 个警告\x1b[0m`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`\x1b[33m校验通过：${warnings} 个警告\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[32m校验全部通过\x1b[0m`);
  process.exit(0);
}
