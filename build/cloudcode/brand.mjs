/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profilesPath = path.join(root, 'build/cloudcode/brands.json');

/** Apply a complete brand profile without changing unrelated product configuration. */
export function applyBrand(product, profile) {
	return { ...product, ...profile };
}

/** Select a checked-in profile; typos must not silently build another brand. */
export function readBrand(name) {
	const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
	if (!Object.hasOwn(profiles, name)) {
		throw new Error('Unknown brand: ' + name + '. Choose cloudcompute or atmoscode.');
	}
	return profiles[name];
}

/** Update product.json for the selected build, retaining dependencies and version metadata. */
export function prepareBrand(name, productPath = path.join(root, 'product.json')) {
	const profile = readBrand(name);
	const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	const branded = applyBrand(product, profile);
	fs.writeFileSync(productPath, JSON.stringify(branded, null, '\t') + '\n');
	return branded;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		if (args.length !== 2 || args[0] !== '--brand') {
			throw new Error('Usage: node build/cloudcode/brand.mjs --brand <cloudcompute|atmoscode>');
		}
		const product = prepareBrand(args[1]);
		process.stdout.write('Prepared ' + product.nameShort + ' for ' + product.cloudCodeBranding.serverUrl + '\n');
	} catch (error) {
		process.stderr.write(String(error.message) + '\n');
		process.exitCode = 1;
	}
}
