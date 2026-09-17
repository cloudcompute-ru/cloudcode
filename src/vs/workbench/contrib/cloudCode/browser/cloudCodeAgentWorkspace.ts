/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { match } from '../../../../base/common/glob.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqual, joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStatWithPartialMetadata } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { escapeGlobPattern, QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { IFileQuery, ISearchService, resultIsMatch } from '../../../services/search/common/search.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { CloudCodeAgentToolCall, ICloudCodeAgentToolResult, ICloudCodeAgentWorkspace, ICloudCodeAgentWorkspaceSession } from '../common/cloudCodeAgent.js';
import { CLOUDCODE_MAX_ATTACHMENT_BYTES, ICloudCodeAttachment } from '../common/cloudCodeChatContext.js';

const maxResults = 50;
const maxSearchMatches = 20;
const maxResultBytes = 4 * 1024;
// Local read/search budget. Only bounded excerpts (16 KiB) become inference context.
const maxReadFileBytes = 16 * 1024 * 1024;
const maxReadLines = 200;
const excludedDirectories = ['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache', '.venv', 'venv', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.terraform', '.docker'];
const excludedFiles = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.crt', '*.cer', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'credentials*', 'secrets*', 'service-account*.json', '.npmrc', '.netrc', '.pypirc', '*.keystore', '*.jks', '*.sqlite', '*.db', '*.tfstate*'];
class CloudCodeAgentWorkspaceError extends Error { }

const excludePatterns = [...excludedDirectories.map(name => `**/${name}/**`), ...excludedFiles.map(name => `**/${name}`)];

/** Creates read-only exploration sessions anchored to the current workspace folders. */
export class CloudCodeAgentWorkspace implements ICloudCodeAgentWorkspace {

	private readonly queryBuilder: QueryBuilder;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
		@ISearchService private readonly searchService: ISearchService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IModelService private readonly modelService: IModelService,
	) {
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
	}

	createSession(): ICloudCodeAgentWorkspaceSession {
		const folders = this.workspaceContextService.getWorkspace().folders.map(folder => ({ name: folder.name, uri: folder.uri }));
		const session = new CloudCodeAgentWorkspaceSession(folders, this.queryBuilder, this.workspaceContextService, this.workspaceTrustService, this.searchService, this.fileService, this.textFileService, this.modelService);
		session.assertValid();
		return session;
	}
}

/** Native search applies configured exclusions and ignore files before results become model context. */
class CloudCodeAgentWorkspaceSession implements ICloudCodeAgentWorkspaceSession {

	readonly roots: readonly { id: string; name: string }[];
	private disposed = false;

	constructor(
		private readonly folders: readonly Pick<IWorkspaceFolder, 'name' | 'uri'>[],
		private readonly queryBuilder: QueryBuilder,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly workspaceTrustService: IWorkspaceTrustManagementService,
		private readonly searchService: ISearchService,
		private readonly fileService: IFileService,
		private readonly textFileService: ITextFileService,
		private readonly modelService: IModelService,
	) {
		this.roots = folders.map((folder, index) => ({ id: String(index + 1), name: folder.name }));
	}

	assertValid(): void {
		if (this.disposed) {
			throw new CancellationError();
		}
		if (!this.workspaceTrustService.isWorkspaceTrusted()) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.trust', "Trust this workspace before using Agent mode."));
		}
		if (!this.folders.length) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.noFolder', "Open a project folder before using Agent mode."));
		}
		const current = this.workspaceContextService.getWorkspace().folders;
		if (current.length !== this.folders.length || current.some((folder, index) => folder.name !== this.folders[index].name || !isEqual(folder.uri, this.folders[index].uri))) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.changedWorkspace', "The workspace folders changed. Start a new Agent request."));
		}
		if (this.folders.some(folder => folder.uri.scheme !== Schemas.file && folder.uri.scheme !== Schemas.vscodeRemote)) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.unsupportedWorkspace', "Agent mode supports local and remote project folders only."));
		}
	}

	resolveReference(resource: string): { root: string; path: string } | undefined {
		this.assertValid();
		const uri = URI.parse(resource);
		if (uri.query || uri.fragment) {
			return undefined;
		}
		for (let index = 0; index < this.folders.length; index++) {
			const root = this.folders[index].uri;
			const path = this.pathInRoot(root, uri);
			if (path && isEqual(joinPath(root, path), uri)) {
				return { root: this.roots[index].id, path };
			}
		}
		return undefined;
	}


	/** Checks edit capabilities without reading source or bypassing native ignore rules. */
	async authorizeEditPath(rootId: string, path: string, token: CancellationToken, requireSearchEligibility = true): Promise<{ resource: string; exists: boolean }> {
		try {
			return await this.authorizeEditPathImpl(rootId, path, token, requireSearchEligibility);
		} catch (error) {
			this.check(token);
			if (error instanceof CloudCodeAgentWorkspaceError || error instanceof CancellationError) {
				throw error;
			}
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.readFailed', "Could not explore this project path. It may be unavailable, binary, or too large."));
		}
	}

	private async authorizeEditPathImpl(rootId: string, path: string, token: CancellationToken, requireSearchEligibility: boolean): Promise<{ resource: string; exists: boolean }> {
		this.check(token);
		this.validatePath(path);
		const index = this.roots.findIndex(root => root.id === rootId);
		if (index < 0) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.invalidRoot', "Choose one of the available workspace root IDs."));
		}
		const root = this.folders[index].uri;
		const resource = joinPath(root, path);
		// Only the final leaf may be absent. Missing/linked parents never grant a capability.
		const separator = path.lastIndexOf('/');
		const parent = await this.assertSafePath(root, separator < 0 ? '' : path.slice(0, separator), token);
		if (!parent.isDirectory) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.notDirectory', "Choose a project directory to list."));
		}
		let stat: IFileStatWithPartialMetadata;
		try {
			stat = await raceCancellationError(this.fileService.stat(resource), token);
		} catch (error) {
			this.check(token);
			if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return { resource: resource.toString(), exists: false };
			}
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.readFailed', "Could not explore this project path. It may be unavailable, binary, or too large."));
		}
		this.check(token);
		if (!stat.isFile || stat.isSymbolicLink || (requireSearchEligibility && !await this.isEligible(root, path, token))) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.unavailableFile', "This file is unavailable or excluded by project search settings or ignore files."));
		}
		this.check(token);
		return { resource: resource.toString(), exists: true };
	}

	async execute(call: CloudCodeAgentToolCall, token: CancellationToken): Promise<ICloudCodeAgentToolResult> {
		this.check(token);
		const rootIndex = this.roots.findIndex(root => root.id === call.root);
		if (rootIndex < 0) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.invalidRoot', "Choose one of the available workspace root IDs."));
		}
		const root = this.folders[rootIndex].uri;
		try {
			await this.assertSafePath(root, '', token);
			switch (call.tool) {
				case 'list': return await this.list(root, call.path, token);
				case 'findFiles': return await this.findFiles(root, call.query, token);
				case 'search': return await this.search(root, call.query, token);
				case 'read': return await this.read(root, call, token);
			}
		} catch (error) {
			this.check(token);
			if (error instanceof CloudCodeAgentWorkspaceError || error instanceof CancellationError) {
				throw error;
			}
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.readFailed', "Could not explore this project path. It may be unavailable, binary, or too large."));
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private check(token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		this.assertValid();
	}

	private query(root: URI, pattern: string, limit = maxResults): IFileQuery {
		return this.queryBuilder.file([root], {
			...this.searchOptions(), filePattern: pattern, shouldGlobSearch: true, maxResults: limit,
		});
	}

	private searchOptions() {
		return {
			_reason: 'cloudCodeAgent',
			disregardIgnoreFiles: false,
			disregardGlobalIgnoreFiles: false,
			disregardParentIgnoreFiles: false,
			ignoreSymlinks: true,
			ignoreGlobCase: true,
			excludePattern: [{ pattern: excludePatterns }],
		};
	}

	private validatePath(path: string, allowEmpty = false): void {
		const segments = path.split('/');
		if ((!path && !allowEmpty) || path.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(path) || (path && segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) || segments.length > 40) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.invalidPath', "Use a relative project path with forward slashes and no parent traversal."));
		}
		if (segments.some(segment => excludedDirectories.includes(segment.toLowerCase())) || segments.some(segment => excludedFiles.some(pattern => match(pattern, segment, { ignoreCase: true })))) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.excludedPath', "This path is excluded from Agent exploration."));
		}
	}

	/** Every component is checked; checking just the final file would miss linked parent folders. */
	private async assertSafePath(root: URI, path: string, token: CancellationToken): Promise<IFileStatWithPartialMetadata> {
		this.validatePath(path, true);
		let resource = root;
		let stat = await raceCancellationError(this.fileService.stat(resource), token);
		this.check(token);
		if (stat.isSymbolicLink || !stat.isDirectory) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.linkedRoot', "Open a project folder that is not a symbolic link."));
		}
		const segments = path ? path.split('/') : [];
		for (let index = 0; index < segments.length; index++) {
			resource = joinPath(resource, segments[index]);
			stat = await raceCancellationError(this.fileService.stat(resource), token);
			this.check(token);
			if (stat.isSymbolicLink || (index < segments.length - 1 && !stat.isDirectory)) {
				throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.symbolicLink', "Symbolic links are excluded from Agent exploration."));
			}
		}
		return stat;
	}

	private pathInRoot(root: URI, resource: URI): string | undefined {
		const path = relativePath(root, resource);
		if (!path || path.startsWith('../') || path === '..') {
			return undefined;
		}
		try {
			this.validatePath(path);
			return path;
		} catch {
			return undefined;
		}
	}

	private async isEligible(root: URI, path: string, token: CancellationToken): Promise<boolean> {
		// An includePattern overrides gitignore. A glob filePattern filters the already eligible files instead.
		// The **/ prefix also prevents native exact-name searches from bypassing sibling exclusions.
		const result = await raceCancellationError(this.searchService.fileSearch(this.query(root, `**/${escapeGlobPattern(path)}`), token), token);
		this.check(token);
		const resource = joinPath(root, path);
		return result.results.some(file => isEqual(file.resource, resource));
	}

	private async list(root: URI, path: string, token: CancellationToken): Promise<ICloudCodeAgentToolResult> {
		this.validatePath(path, true);
		const stat = await this.assertSafePath(root, path, token);
		if (!stat.isDirectory) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.notDirectory', "Choose a project directory to list."));
		}
		const prefix = path ? `${path}/` : '';
		const results = await raceCancellationError(this.searchService.fileSearch(this.query(root, path ? `${escapeGlobPattern(path)}/**` : '**', 500), token), token);
		this.check(token);
		const entries = new Set<string>();
		for (const file of results.results) {
			const relative = this.pathInRoot(root, file.resource);
			if (!relative?.startsWith(prefix)) {
				continue;
			}
			const suffix = relative.slice(prefix.length);
			const separator = suffix.indexOf('/');
			const entry = separator < 0 ? relative : prefix + suffix.slice(0, separator + 1);
			if (entries.has(entry)) {
				continue;
			}
			try {
				await this.assertSafePath(root, entry.replace(/\/$/, ''), token);
				entries.add(entry);
			} catch {
				this.check(token);
			}
			if (entries.size >= maxResults) {
				break;
			}
		}
		return this.result([...entries].sort(), !!results.limitHit || entries.size >= maxResults, 'Directories contain searchable files; ignored and empty directories are omitted.');
	}

	private validateQuery(query: string): void {
		if (!query.trim() || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.invalidQuery', "Search for 1 to 200 characters on a single line."));
		}
	}

	private async findFiles(root: URI, query: string, token: CancellationToken): Promise<ICloudCodeAgentToolResult> {
		this.validateQuery(query);
		const results = await raceCancellationError(this.searchService.fileSearch(this.query(root, `**/*${escapeGlobPattern(query)}*`), token), token);
		this.check(token);
		const paths: string[] = [];
		for (const file of results.results.slice(0, maxResults)) {
			const path = this.pathInRoot(root, file.resource);
			if (!path) {
				continue;
			}
			try {
				const stat = await this.assertSafePath(root, path, token);
				if (stat.isFile) {
					paths.push(path);
				}
			} catch {
				this.check(token);
			}
		}
		return this.result(paths, !!results.limitHit);
	}

	private async search(root: URI, query: string, token: CancellationToken): Promise<ICloudCodeAgentToolResult> {
		this.validateQuery(query);
		const searchQuery = this.queryBuilder.text({ pattern: query, isRegExp: false, isCaseSensitive: false }, [root], {
			...this.searchOptions(), maxResults: maxSearchMatches, maxFileSize: maxReadFileBytes,
			previewOptions: { matchLines: 1, charsPerLine: 160 }, surroundingContext: 0,
		});
		const results = await raceCancellationError(this.searchService.textSearch(searchQuery, token), token);
		this.check(token);
		const matches: { path: string; line: number; text: string }[] = [];
		const seen = new Set<string>();
		for (const file of results.results.slice(0, maxSearchMatches)) {
			if (seen.has(file.resource.toString())) {
				continue;
			}
			seen.add(file.resource.toString());
			const path = this.pathInRoot(root, file.resource);
			if (!path || !await this.isEligible(root, path, token)) {
				continue;
			}
			try {
				await this.assertSafePath(root, path, token);
			} catch {
				this.check(token);
				continue;
			}
			const model = this.modelService.getModel(file.resource);
			if (model) {
				// Search the current buffer again: provider previews may describe the saved file instead.
				if (model.getValueLength() <= maxReadFileBytes && !model.getValue().includes('\0')) {
					const found = model.findMatches(query, false, false, false, null, false, maxSearchMatches - matches.length);
					for (const item of found) {
						matches.push({ path, line: item.range.startLineNumber, text: model.getLineContent(item.range.startLineNumber).slice(0, 160) });
					}
				}
			} else {
				for (const item of file.results ?? []) {
					if (resultIsMatch(item) && !item.previewText.includes('\0')) {
						for (const range of item.rangeLocations) {
							matches.push({ path, line: range.source.startLineNumber + 1, text: item.previewText.slice(0, 160) });
							if (matches.length >= maxSearchMatches) {
								break;
							}
						}
					}
					if (matches.length >= maxSearchMatches) {
						break;
					}
				}
			}
			if (matches.length >= maxSearchMatches) {
				break;
			}
		}
		this.check(token);
		return this.result(matches, !!results.limitHit || matches.length >= maxSearchMatches);
	}

	private async read(root: URI, call: Extract<CloudCodeAgentToolCall, { tool: 'read' }>, token: CancellationToken): Promise<ICloudCodeAgentToolResult> {
		this.validatePath(call.path);
		const ranged = call.startLine !== undefined || call.endLine !== undefined;
		if (ranged && (!Number.isSafeInteger(call.startLine) || !Number.isSafeInteger(call.endLine) || call.startLine! < 1 || call.endLine! < call.startLine! || call.endLine! - call.startLine! + 1 > maxReadLines)) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.invalidLines', "Request an inclusive line range of 1 to 200 lines."));
		}
		const stat = await this.assertSafePath(root, call.path, token);
		if (!stat.isFile || !await this.isEligible(root, call.path, token)) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.unavailableFile', "This file is unavailable or excluded by project search settings or ignore files."));
		}
		const resource = joinPath(root, call.path);
		let model = this.modelService.getModel(resource);
		let value: string;
		if (model) {
			value = this.modelValue(model, ranged);
		} else {
			if (stat.size > (ranged ? maxReadFileBytes : CLOUDCODE_MAX_ATTACHMENT_BYTES)) {
				throw this.sizeError(ranged);
			}
			const content = await raceCancellationError(this.textFileService.read(resource, { acceptTextOnly: true, limits: { size: ranged ? maxReadFileBytes : CLOUDCODE_MAX_ATTACHMENT_BYTES } }), token);
			this.check(token);
			await this.assertSafePath(root, call.path, token);
			model = this.modelService.getModel(resource);
			value = model ? this.modelValue(model, ranged) : content.value;
		}
		if (VSBuffer.fromString(value).byteLength > (ranged ? maxReadFileBytes : CLOUDCODE_MAX_ATTACHMENT_BYTES)) {
			throw this.sizeError(ranged);
		}
		if (value.includes('\0')) {
			throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.binaryFile', "Agent mode reads text files only."));
		}
		const folder = this.folders.find(folder => isEqual(folder.uri, root))!;
		const label = this.folders.length > 1 ? `${folder.name}/${call.path}` : call.path;
		let attachment: ICloudCodeAttachment;
		if (ranged) {
			const lines = value.split(/\r\n|\r|\n/);
			if (call.startLine! > lines.length) {
				throw new CloudCodeAgentWorkspaceError(localize('cloudCode.agent.linesOutsideFile', "The requested range exceeds the file's {0} lines.", lines.length));
			}
			const endLine = Math.min(call.endLine!, lines.length);
			const starts = [0];
			for (const separator of value.matchAll(/\r\n|\r|\n/g)) {
				starts.push(separator.index + separator[0].length);
			}
			const range = { startLineNumber: call.startLine!, startColumn: 1, endLineNumber: endLine, endColumn: lines[endLine - 1].length + 1 };
			const content = model ? model.getValueInRange(range) : value.slice(starts[call.startLine! - 1], starts[endLine - 1] + lines[endLine - 1].length);
			attachment = { id: `${resource.toString()}#${range.startLineNumber}:1-${range.endLineNumber}:${range.endColumn}`, resource: resource.toString(), label: `${label}:${call.startLine}-${endLine}`, range, startLine: call.startLine, endLine, content, languageId: model?.getLanguageId() };
		} else {
			attachment = { id: resource.toString(), resource: resource.toString(), label, content: value, languageId: model?.getLanguageId() };
		}
		if (VSBuffer.fromString(attachment.content).byteLength > CLOUDCODE_MAX_ATTACHMENT_BYTES) {
			throw this.sizeError(false);
		}
		this.check(token);
		return { text: JSON.stringify({ path: call.path, startLine: attachment.startLine, endLine: attachment.endLine, bytes: VSBuffer.fromString(attachment.content).byteLength }), attachment };
	}

	private modelValue(model: ITextModel, ranged: boolean): string {
		if (model.getValueLength() > (ranged ? maxReadFileBytes : CLOUDCODE_MAX_ATTACHMENT_BYTES)) {
			throw this.sizeError(ranged);
		}
		return model.getValue();
	}

	private sizeError(ranged: boolean): Error {
		return new CloudCodeAgentWorkspaceError(ranged
			? localize('cloudCode.agent.rangeFileTooLarge', "Agent mode can read ranges from files up to 16 MiB.")
			: localize('cloudCode.agent.readTooLarge', "Read at most 16 KiB at a time. Request a smaller line range."));
	}

	private result(entries: readonly (string | { path: string; line: number; text: string })[], truncated: boolean, note?: string): ICloudCodeAgentToolResult {
		const included = [...entries];
		let text = JSON.stringify({ results: included, truncated, note });
		while (VSBuffer.fromString(text).byteLength > maxResultBytes && included.length) {
			included.pop();
			text = JSON.stringify({ results: included, truncated: true, note });
		}
		return { text };
	}
}
