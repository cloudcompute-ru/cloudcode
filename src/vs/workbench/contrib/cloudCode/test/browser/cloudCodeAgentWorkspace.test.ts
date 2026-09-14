/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { match } from '../../../../../base/common/glob.js';
import { isEqualOrParent, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { IFileMatch, IFileQuery, ISearchComplete, ISearchService, ITextQuery, TextSearchMatch } from '../../../../services/search/common/search.js';
import { IReadTextFileOptions, ITextFileContent, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { CloudCodeAgentWorkspace } from '../../browser/cloudCodeAgentWorkspace.js';
import { ICloudCodeAgentWorkspaceSession } from '../../common/cloudCodeAgent.js';

suite('CloudCodeAgentWorkspace', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const root = URI.file('/project');
	let folders: IWorkspaceFolder[];
	let trusted: boolean;
	let files: Map<string, string>;
	let models: Map<string, ITextModel>;
	let ignored: Set<string>;
	let links: Set<string>;
	let fileQueries: IFileQuery[];
	let textQueries: ITextQuery[];
	let textResults: IFileMatch[];
	let reads: { path: string; options: IReadTextFileOptions | undefined }[];
	let stats: string[];
	let pendingRead: DeferredPromise<ITextFileContent> | undefined;
	let pendingSearch: DeferredPromise<ISearchComplete> | undefined;
	let service: CloudCodeAgentWorkspace;
	let session: ICloudCodeAgentWorkspaceSession;
	let configuration: TestConfigurationService;

	setup(() => {
		folders = [toWorkspaceFolder(root)];
		trusted = true;
		files = new Map();
		models = new Map();
		ignored = new Set();
		links = new Set();
		fileQueries = [];
		textQueries = [];
		textResults = [];
		reads = [];
		stats = [];
		pendingRead = undefined;
		pendingSearch = undefined;
		const workspace = upcastPartial<IWorkspaceContextService>({
			getWorkspace: () => upcastPartial<IWorkspace>({ folders }),
			getWorkspaceFolder: uri => folders.find(folder => isEqualOrParent(uri, folder.uri)) ?? null,
		});
		configuration = new TestConfigurationService({
			files: { exclude: { '**/hidden/**': true } },
			search: { exclude: { '**/private/**': true }, useIgnoreFiles: false, useGlobalIgnoreFiles: false, useParentIgnoreFiles: false, followSymlinks: true },
			editor: { wordSeparators: '' },
		});
		disposables.add(configuration.onDidChangeConfigurationEmitter);
		const instantiation = disposables.add(new TestInstantiationService());
		instantiation.stubInstance(QueryBuilder, new QueryBuilder(configuration, workspace, upcastPartial<IEditorGroupsService>({}), new NullLogService(), upcastPartial<IPathService>({}), upcastPartial<IUriIdentityService>({})));
		service = new CloudCodeAgentWorkspace(instantiation, workspace,
			upcastPartial<IWorkspaceTrustManagementService>({ isWorkspaceTrusted: () => trusted }),
			upcastPartial<ISearchService>({
				fileSearch: async query => {
					fileQueries.push(query);
					if (pendingSearch) {
						return pendingSearch.p;
					}
					const folder = query.folderQueries[0];
					const results = [...files.keys()].map(value => URI.parse(value)).filter(uri => {
						const path = relativePath(folder.folder, uri);
						return !!path && !path.startsWith('../') && !ignored.has(uri.toString())
							&& match(query.filePattern ?? '**', path, { ignoreCase: true })
							&& !match(query.excludePattern ?? {}, path, { ignoreCase: true })
							&& !folder.excludePattern?.some(exclude => match(exclude.pattern, path, { ignoreCase: true }));
					}).map(resource => ({ resource }));
					return { results: results.slice(0, query.maxResults), messages: [], limitHit: results.length > (query.maxResults ?? Infinity) };
				},
				textSearch: async query => {
					textQueries.push(query);
					return { results: textResults, messages: [] };
				},
			}),
			upcastPartial<IFileService>({ stat: async uri => {
				const key = uri.toString();
				stats.push(key);
				const value = files.get(key);
				const isDirectory = folders.some(folder => folder.uri.toString() === key) || [...files.keys()].some(file => file.startsWith(key + '/'));
				if (value === undefined && !isDirectory && !links.has(key)) {
					throw new Error(`File missing on machine: ${key}`);
				}
				return upcastPartial<IFileStatWithPartialMetadata>({ isFile: value !== undefined, isDirectory, isSymbolicLink: links.has(key), size: new TextEncoder().encode(value).byteLength });
			} }),
			upcastPartial<ITextFileService>({ read: async (uri, options) => {
				reads.push({ path: uri.toString(), options });
				return pendingRead?.p ?? upcastPartial<ITextFileContent>({ value: files.get(uri.toString())! });
			} }),
			upcastPartial<IModelService>({ getModel: uri => models.get(uri.toString()) ?? null }),
		);
		session = disposables.add(service.createSession());
	});

	function addFile(path: string, content = 'saved', folder = root): URI {
		const uri = URI.joinPath(folder, path);
		files.set(uri.toString(), content);
		return uri;
	}

	function openModel(uri: URI, content: string): ITextModel {
		const model = disposables.add(createTextModel(content, 'typescript', undefined, uri));
		models.set(uri.toString(), model);
		return model;
	}

	function read(path: string, startLine?: number, endLine?: number) {
		return session.execute({ tool: 'read', root: '1', path, startLine, endLine }, CancellationToken.None);
	}

	test('finds files with native ignores and configured exclusions always enabled', async () => {
		addFile('src/account.ts');
		addFile('hidden/account.ts');
		addFile('private/account.ts');
		addFile('node_modules/account.ts');
		ignored.add(addFile('ignored/account.ts').toString());
		const result = await session.execute({ tool: 'findFiles', root: '1', query: 'account' }, CancellationToken.None);
		const query = fileQueries[0];
		assert.deepStrictEqual({ result: JSON.parse(result.text), flags: query.folderQueries.map(folder => ({ ignoreFiles: folder.disregardIgnoreFiles, global: folder.disregardGlobalIgnoreFiles, parent: folder.disregardParentIgnoreFiles, symlinks: folder.ignoreSymlinks })), includes: query.includePattern, pattern: query.filePattern }, {
			result: { results: ['src/account.ts'], truncated: false },
			flags: [{ ignoreFiles: false, global: false, parent: false, symlinks: true }], includes: undefined, pattern: '**/*account*',
		});
	});

	test('lists directories derived only from eligible files', async () => {
		addFile('src/account.ts');
		addFile('src/second.ts');
		addFile('package.json');
		addFile('.git/config');
		addFile('.env');
		const result = JSON.parse((await session.execute({ tool: 'list', root: '1', path: '' }, CancellationToken.None)).text);
		assert.deepStrictEqual(result.results, ['package.json', 'src/']);
	});

	test('rejects parent traversal, absolute paths, URL schemes and secret paths before reading', async () => {
		for (const path of ['../outside.txt', '/outside.txt', 'src/../../private', 'file:///etc/passwd', 'C:/secret.txt', 'src\\file.ts', 'src//file.ts', './file.ts', '.env', 'src/.ENV.local', 'keys/server.pem', '.aws/config', 'secrets/private.txt', 'node_modules/a.ts']) {
			await assert.rejects(read(path), /relative project path|excluded/);
		}
		assert.deepStrictEqual(reads, []);
	});

	test('rechecks native eligibility for reads, including ignored open editor buffers', async () => {
		const uri = addFile('ignored.ts');
		ignored.add(uri.toString());
		openModel(uri, 'unsaved secret');
		await assert.rejects(read('ignored.ts'), /unavailable or excluded/);
		assert.deepStrictEqual({ reads, pattern: fileQueries[0].filePattern, includes: fileQueries[0].includePattern }, { reads: [], pattern: '**/ignored.ts', includes: undefined });
	});

	test('escaped filename queries support framework route brackets', async () => {
		addFile('src/[id]/page.ts');
		assert.strictEqual((await read('src/[id]/page.ts')).attachment?.content, 'saved');
	});

	test('checks symbolic links at the root, intermediate directories and final files', async () => {
		const uri = addFile('src/file.ts');
		for (const linked of [root, URI.joinPath(root, 'src'), uri]) {
			links.add(linked.toString());
			await assert.rejects(read('src/file.ts'), /symbolic link|Symbolic link/);
			links.clear();
		}
		assert.deepStrictEqual(reads, []);
	});

	test('captures unsaved contents and keeps the snapshot stable without disk writes', async () => {
		const uri = addFile('src/file.ts');
		const model = openModel(uri, 'unsaved text');
		const result = await read('src/file.ts');
		model.setValue('later change');
		assert.deepStrictEqual({ attachment: result.attachment, metadata: JSON.parse(result.text), reads }, {
			attachment: { id: uri.toString(), resource: uri.toString(), label: 'src/file.ts', content: 'unsaved text', languageId: 'typescript' },
			metadata: { path: 'src/file.ts', bytes: 12 }, reads: [],
		});
	});

	test('reads exact inclusive line ranges with mixed line endings and edit metadata', async () => {
		const uri = addFile('mixed.ts', 'first\r\nsecond\nthird\r\nfourth');
		const result = await read('mixed.ts', 2, 3);
		assert.deepStrictEqual(result.attachment, {
			id: `${uri.toString()}#2:1-3:6`, resource: uri.toString(), label: 'mixed.ts:2-3', content: 'second\nthird', languageId: undefined,
			range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 6 }, startLine: 2, endLine: 3,
		});
	});

	test('clamps the requested end line to EOF and keeps the edit range exact', async () => {
		addFile('short.ts', 'first\nsecond');
		const attachment = (await read('short.ts', 1, 100)).attachment;
		assert.deepStrictEqual({ content: attachment?.content, endLine: attachment?.endLine, range: attachment?.range }, { content: 'first\nsecond', endLine: 2, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 7 } });
	});

	test('enforces UTF-8 bytes, maximum range length, bounded source files and binary rejection', async () => {
		addFile('utf8.ts', '界'.repeat(6000));
		addFile('big.ts', 'x'.repeat(512 * 1024 + 1));
		addFile('binary.ts', 'before\0after');
		addFile('short.ts', 'first\nsecond');
		await assert.rejects(read('utf8.ts'), /16 KiB/);
		await assert.rejects(read('big.ts', 1, 1), /512 KiB/);
		await assert.rejects(read('short.ts', 1, 201), /1 to 200 lines/);
		await assert.rejects(read('short.ts', 1), /1 to 200 lines/);
		await assert.rejects(read('short.ts', 3, 4), /exceeds the file's 2 lines/);
		await assert.rejects(read('binary.ts'), /text files only/);
	});

	test('returns an actionable range error for a large unsaved buffer', async () => {
		const uri = addFile('large.ts');
		openModel(uri, 'first\n' + 'x'.repeat(20 * 1024));
		await assert.rejects(read('large.ts'), /smaller line range/);
		assert.strictEqual((await read('large.ts', 1, 1)).attachment?.content, 'first');
	});

	test('uses the current buffer when the file opens during a pending disk read', async () => {
		const uri = addFile('file.ts');
		pendingRead = new DeferredPromise<ITextFileContent>();
		const result = read('file.ts');
		while (!reads.length) {
			await Promise.resolve();
		}
		openModel(uri, 'opened unsaved');
		await pendingRead.complete(upcastPartial<ITextFileContent>({ value: 'old disk text' }));
		assert.strictEqual((await result).attachment?.content, 'opened unsaved');
	});

	test('searches current unsaved text and filters ignored editor previews and out-of-root results', async () => {
		const current = addFile('src/current.ts');
		const hidden = addFile('ignored.ts');
		ignored.add(hidden.toString());
		openModel(current, 'first\nneedle unsaved');
		const range = { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 6 };
		textResults = [current, current, hidden, URI.file('/outside/secret.ts')].map(resource => ({ resource, results: [new TextSearchMatch('needle saved secret', range)] }));
		const result = await session.execute({ tool: 'search', root: '1', query: 'needle' }, CancellationToken.None);
		assert.deepStrictEqual({ output: JSON.parse(result.text), limits: { files: textQueries[0].maxFileSize, matches: textQueries[0].maxResults }, pattern: textQueries[0].contentPattern.pattern }, {
			output: { results: [{ path: 'src/current.ts', line: 2, text: 'needle unsaved' }], truncated: false }, limits: { files: 512 * 1024, matches: 20 }, pattern: 'needle',
		});
	});

	test('bounds UTF-8 search output and indicates omitted results', async () => {
		for (let index = 0; index < 50; index++) {
			addFile(`${'界'.repeat(100)}${index}.ts`);
		}
		const result = await session.execute({ tool: 'findFiles', root: '1', query: '.ts' }, CancellationToken.None);
		assert.deepStrictEqual({ withinLimit: new TextEncoder().encode(result.text).byteLength <= 4096, truncated: JSON.parse(result.text).truncated }, { withinLimit: true, truncated: true });
	});

	test('cancelled tool calls stop promptly during an unresolved native search', async () => {
		const cancellation = disposables.add(new CancellationTokenSource());
		pendingSearch = new DeferredPromise<ISearchComplete>();
		const result = session.execute({ tool: 'findFiles', root: '1', query: 'file' }, cancellation.token);
		while (!fileQueries.length) {
			await Promise.resolve();
		}
		cancellation.cancel();
		await assert.rejects(result, /Canceled/);
		await pendingSearch.complete({ results: [], messages: [] });
	});

	test('trust changes during a disk read prevent returning source contents', async () => {
		addFile('file.ts');
		pendingRead = new DeferredPromise<ITextFileContent>();
		const result = read('file.ts');
		while (!reads.length) {
			await Promise.resolve();
		}
		trusted = false;
		await pendingRead.complete(upcastPartial<ITextFileContent>({ value: 'private code' }));
		await assert.rejects(result, /Trust this workspace/);
	});

	test('invalidates sessions on root changes, disposal, untrusted or unsupported workspaces', async () => {
		folders = [toWorkspaceFolder(URI.file('/different'))];
		assert.throws(() => session.assertValid(), /workspace folders changed/);
		folders = [toWorkspaceFolder(root)];
		session.dispose();
		assert.throws(() => session.assertValid(), /Canceled/);
		trusted = false;
		assert.throws(() => service.createSession(), /Trust this workspace/);
		trusted = true;
		folders = [];
		assert.throws(() => service.createSession(), /Open a project folder/);
		folders = [toWorkspaceFolder(URI.parse('https://example.com/project'))];
		assert.throws(() => service.createSession(), /local and remote project folders only/);
	});

	test('uses explicit multi-root IDs and labels without transmitting local URIs', async () => {
		const other = URI.file('/second');
		folders.push(toWorkspaceFolder(other));
		addFile('file.ts', 'second source', other);
		session = disposables.add(service.createSession());
		const result = await session.execute({ tool: 'read', root: '2', path: 'file.ts' }, CancellationToken.None);
		assert.deepStrictEqual({ roots: session.roots, label: result.attachment?.label, text: result.text }, {
			roots: [{ id: '1', name: 'project' }, { id: '2', name: 'second' }], label: 'second/file.ts', text: '{"path":"file.ts","bytes":13}',
		});
		await assert.rejects(session.execute({ tool: 'read', root: '99', path: 'file.ts' }, CancellationToken.None), /available workspace root IDs/);
	});

	test('supports remote file providers with the same symbolic-link checks', async () => {
		const remote = URI.parse('vscode-remote://ssh-remote+host/project');
		folders = [toWorkspaceFolder(remote)];
		const uri = addFile('file.ts', 'remote text', remote);
		session = disposables.add(service.createSession());
		assert.strictEqual((await read('file.ts')).attachment?.resource, uri.toString());
		links.add(uri.toString());
		await assert.rejects(read('file.ts'), /Symbolic links/);
	});

	test('sanitizes provider errors instead of exposing machine paths to inference', async () => {
		await assert.rejects(read('missing.ts'), { message: 'Could not explore this project path. It may be unavailable, binary, or too large.' });
	});
});
