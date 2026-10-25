/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { applyBrand, prepareBrand, readBrand } from './brand.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const original = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
const helper = fs.readFileSync(path.join(root, 'src/vs/platform/cloudCode/common/cloudCodeBrand.ts'), 'utf8');

/** Execute the runtime branding module with the product data supplied by a packaged app. */
function runtimeBranding(branding) {
	const code = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', code)(() => ({ __esModule: true, default: { cloudCodeBranding: branding } }), module, module.exports);
	return module.exports;
}

test('desktop UI and default sign-in server follow each product profile', () => {
	for (const name of ['cloudcompute', 'atmoscode']) {
		const profile = readBrand(name);
		const runtime = runtimeBranding(profile.cloudCodeBranding);
		assert.deepEqual(
			[runtime.CLOUDCODE_PRODUCT_NAME, runtime.CLOUDCODE_SERVICE_NAME, runtime.CLOUDCODE_BRAND_SERVER],
			[profile.nameShort, profile.cloudCodeBranding.serviceName, profile.cloudCodeBranding.serverUrl]
		);
	}
	assert.equal(runtimeBranding(undefined).CLOUDCODE_BRAND_SERVER, 'https://app.cloudcompute.ru');
});

test('AtmosCode installs, profiles, protocols and OS application identities are distinct', () => {
	const ru = readBrand('cloudcompute');
	const en = readBrand('atmoscode');
	for (const key of ['applicationName', 'dataFolderName', 'sharedDataFolderName', 'win32MutexName', 'win32x64AppId', 'win32x64UserAppId', 'win32arm64AppId', 'win32arm64UserAppId', 'win32AppUserModelId', 'darwinBundleIdentifier', 'urlProtocol']) {
		assert.notEqual(en[key], ru[key], key);
	}
	assert.equal(en.nameShort, 'AtmosCode');
	assert.equal(en.cloudCodeBranding.serverUrl, 'https://app.atmoscompute.com');
	assert.equal(applyBrand(original, en).disableBuiltinCopilot, original.disableBuiltinCopilot);
	assert.deepEqual(applyBrand(original, en).builtInExtensions, original.builtInExtensions);
});

test('switching back restores legacy product identities and preserves unrelated settings', () => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-brand-'));
	const productPath = path.join(folder, 'product.json');
	try {
		fs.writeFileSync(productPath, JSON.stringify({ ...original, customValue: 'retain' }));
		prepareBrand('atmoscode', productPath);
		const restored = prepareBrand('cloudcompute', productPath);
		for (const key of Object.keys(readBrand('cloudcompute'))) {
			assert.deepEqual(restored[key], readBrand('cloudcompute')[key], key);
		}
		assert.equal(restored.customValue, 'retain');
		assert.equal(restored.win32x64UserAppId, readBrand('cloudcompute').win32x64UserAppId);
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
});

test('invalid brand selection leaves product.json unchanged', () => {
	assert.throws(() => readBrand('english'), /Unknown brand/);
	assert.throws(() => prepareBrand('invalid', '/must-not-be-read/product.json'), /Unknown brand/);
});
+
test('branded localizations retain their formatting arguments and valid TypeScript syntax', () => {
	for (const folder of ['src/vs/platform/cloudCode', 'src/vs/workbench/contrib/cloudCode']) {
		for (const relative of fs.readdirSync(path.join(root, folder), { recursive: true })) {
			if (!relative.endsWith('.ts') || relative.split(path.sep).includes('test')) {
				continue;
			}
			const file = path.join(root, folder, relative);
			const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
			assert.equal(tree.parseDiagnostics.length, 0, relative);
			const visit = node => {
				if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['localize', 'localize2'].includes(node.expression.text)
					&& node.arguments[1] && ts.isStringLiteral(node.arguments[1])) {
					const text = node.arguments[1].text;
					assert.doesNotMatch(text, /\b(?:CloudCode|CloudCompute)\b/, relative);
					for (const match of text.matchAll(/\{(\d+)\}/g)) {
						assert.ok(Number(match[1]) < node.arguments.length - 2, relative + ': ' + text);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(tree);
		}
	}
});
