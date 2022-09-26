import { FileUtils, StandardizedFilePath } from "@ts-morph/common";
import assert from "assert";
import {
    ExportDeclarationStructure,
    FileSystemHost,
    ForEachDescendantTraversalControl,
    ImportDeclarationStructure,
    ModuleDeclaration,
    ModuleDeclarationKind,
    Node,
    OptionalKind,
    Project,
    SourceFile,
    SourceFileStructure,
    Statement,
    StructureKind,
    ts,
} from "ts-morph";

import {
    addTsConfigs,
    formatImports,
    getTsConfigs,
    getTsSourceFiles,
    getTsStyleRelativePath,
    log,
    namespacesDirName,
} from "./utilities.js";

function isInternalDeclaration(node: Node, sourceFile: SourceFile): boolean {
    return !!ts.isInternalDeclaration(node.compilerNode, sourceFile.compilerNode);
}

type NamespaceNameParts = string[];

function namespacePartsToFilename(parts: NamespaceNameParts): string {
    assert(parts.length > 0);
    return `${parts.join(".")}.ts`;
}

// Note: assumes that no namespace declaration has more than one namespace declared within it.
function skipDownToNamespaceBody(statement: ModuleDeclaration) {
    let body = statement.getBodyOrThrow();
    // Not getName(), that returns the full dotted name.
    // TODO: simplify by calling once and splitting?
    const nsNameParts: NamespaceNameParts = [statement.getNameNode().getText()];
    while (Node.isModuleDeclaration(body)) {
        const newBody = body.getBody();
        if (!newBody) {
            break;
        }
        nsNameParts.push(body.getNameNode().getText());
        body = newBody;
    }

    return { body, nsNameParts };
}

function createTopLevelNamespacesToImportSet() {
    const referencedNamespaces = new Map<StandardizedFilePath, Set<string>>();

    return {
        add(sourceFile: SourceFile, namespaceName: string) {
            const path = sourceFile.getFilePath();
            let set = referencedNamespaces.get(path);
            if (!set) {
                set = new Set();
                referencedNamespaces.set(path, set);
            }
            set.add(namespaceName);
        },
        get(sourceFile: SourceFile) {
            return referencedNamespaces.get(sourceFile.getFilePath());
        },
    };
}

interface ProjectRootMapper {
    getTsConfigPath(sourceFilePath: StandardizedFilePath): StandardizedFilePath;
}

function createProjectRootMapper(fs: FileSystemHost): ProjectRootMapper {
    const cache = new Map<StandardizedFilePath, StandardizedFilePath>();

    return {
        getTsConfigPath(sourceFilePath: StandardizedFilePath): StandardizedFilePath {
            const dir = FileUtils.getDirPath(sourceFilePath);
            return _getProjectPath(dir);

            function _getProjectPath(p: StandardizedFilePath): StandardizedFilePath {
                if (FileUtils.isRootDirPath(p)) {
                    throw new Error(`hit project root searching for tsconfig.json for ${dir}`);
                }

                const cached = cache.get(p);
                if (cached) {
                    return cached;
                }

                let tsconfig = FileUtils.pathJoin(p, "tsconfig.json");
                if (!fs.fileExistsSync(tsconfig)) {
                    tsconfig = _getProjectPath(FileUtils.getDirPath(p));
                }

                cache.set(p, tsconfig);
                return tsconfig;
            }
        },
    };
}

function createNamespaceFileSet(fs: FileSystemHost, projectRootMapper: ProjectRootMapper) {
    const newNamespaceFiles = new Map<StandardizedFilePath, Set<StandardizedFilePath>>();
    const extraFilesFieldMembers = new Map<StandardizedFilePath, Set<StandardizedFilePath>>();

    function getOrCreate({
        namespaceFilePath,
        configFilePath,
    }: {
        namespaceFilePath: StandardizedFilePath;
        configFilePath: StandardizedFilePath;
    }) {
        const res = newNamespaceFiles.get(namespaceFilePath);
        if (res) {
            return res;
        }
        const s = new Set<StandardizedFilePath>();
        newNamespaceFiles.set(namespaceFilePath, s);
        let configRes = extraFilesFieldMembers.get(configFilePath);
        if (!configRes) {
            configRes = new Set<StandardizedFilePath>();
            extraFilesFieldMembers.set(configFilePath, configRes);
        }
        configRes.add(namespaceFilePath);
        return s;
    }

    function addNamespaceFile(sourceFile: SourceFile, nsPath: NamespaceNameParts, addFileToNamespace: boolean) {
        const sourceFilePath = sourceFile.getFilePath();
        const configFilePath = projectRootMapper.getTsConfigPath(sourceFilePath);
        const projRootDir = FileUtils.getDirPath(configFilePath);
        const namespacesRoot = FileUtils.pathJoin(projRootDir, namespacesDirName);

        // Shouldn't be required, but if we don't have a real directory on disk, we fail
        // to perform the walk to add the tsconfigs to the project later.
        fs.mkdirSync(namespacesRoot);

        const nsFilePath = FileUtils.pathJoin(namespacesRoot, namespacePartsToFilename(nsPath));
        const inner = getOrCreate({
            namespaceFilePath: nsFilePath,
            configFilePath,
        });

        if (addFileToNamespace) {
            inner.add(sourceFilePath);
        }

        for (let i = 1; i < nsPath.length; i++) {
            const parentNsFile = FileUtils.pathJoin(namespacesRoot, namespacePartsToFilename(nsPath.slice(0, i)));
            getOrCreate({
                namespaceFilePath: parentNsFile,
                configFilePath,
            });
        }
    }

    return {
        ensureNamespaceFileExists(sourceFile: SourceFile, nsPath: NamespaceNameParts) {
            addNamespaceFile(sourceFile, nsPath, /*addFileToNamespace*/ false);
        },
        addFileToNamespace(sourceFile: SourceFile, nsPath: NamespaceNameParts) {
            addNamespaceFile(sourceFile, nsPath, /*addFileToNamespace*/ true);
        },
        has: newNamespaceFiles.has.bind(newNamespaceFiles),
        forEach: newNamespaceFiles.forEach.bind(newNamespaceFiles),
        findAssociatedConfig(path: StandardizedFilePath) {
            return [...extraFilesFieldMembers.entries()].find(([_, addedFiles]) => addedFiles.has(path))![0];
        },
    };
}

interface SimpleConfig {
    references: Set<StandardizedFilePath> | undefined;
    files: StandardizedFilePath[] | undefined;
}

function createConfigFileSet(fs: FileSystemHost, projectRootMapper: ProjectRootMapper) {
    const configs = new Map<StandardizedFilePath, SimpleConfig>();

    return {
        add(sourceFile: SourceFile) {
            const sourceFilePath = sourceFile.getFilePath();
            const configFilePath = projectRootMapper.getTsConfigPath(sourceFilePath);
            const projRootDir = FileUtils.getDirPath(configFilePath);

            if (configs.has(configFilePath)) {
                return;
            }

            const config: { references?: { path: string }[]; files?: string[] } = ts.readConfigFile(
                configFilePath,
                fs.readFileSync
            ).config;

            const refSet = config.references
                ? new Set(config.references.map((r) => FileUtils.getStandardizedAbsolutePath(fs, r.path, projRootDir)))
                : undefined;

            const files = config.files
                ? config.files.map((p) => FileUtils.getStandardizedAbsolutePath(fs, p, projRootDir))
                : undefined;

            configs.set(configFilePath, {
                references: refSet,
                files: files,
            });
        },
        getConfig: configs.get.bind(configs),
    };
}

export function stripNamespaces(project: Project): void {
    const fs = project.getFileSystem();
    // Tracks which namespaces each source file uses.
    const topLevelNamespacesToImport = createTopLevelNamespacesToImportSet();
    // Gets the project config path for a file (since we are loading this as one project)
    const projectRootMapper = createProjectRootMapper(fs);
    // Tracks newly added namespace files.
    const newNamespaceFiles = createNamespaceFileSet(fs, projectRootMapper);
    // Tracks which configs reference which other configs.
    const configFileSet = createConfigFileSet(fs, projectRootMapper);

    const checker = project.getTypeChecker();
    const compilerProgram = project.getProgram().compilerObject;
    const sourceMapper = ts.getSourceMapper({
        useCaseSensitiveFileNames() {
            return ts.sys.useCaseSensitiveFileNames;
        },
        getCurrentDirectory() {
            return compilerProgram.getCurrentDirectory();
        },
        getProgram() {
            return compilerProgram;
        },
        fileExists(path) {
            return fs.fileExistsSync(path);
        },
        readFile(path, encoding) {
            return fs.readFileSync(path, encoding);
        },
        log: () => {},
    });

    log("collecting references to used namespaces");
    for (const sourceFile of getTsSourceFiles(project)) {
        // if (sourceFile.getFilePath().endsWith("tsserver/session.ts")) {
        //     debugger;
        // }

        configFileSet.add(sourceFile);

        sourceFile.forEachDescendant(collectReferencedNamespaces);

        function collectReferencedNamespaces(node: Node, traversal: ForEachDescendantTraversalControl) {
            if (Node.isModuleDeclaration(node) && node.getParentIfKind(ts.SyntaxKind.SourceFile)) {
                const { body, nsNameParts } = skipDownToNamespaceBody(node);

                if (!Node.isModuleBlock(body)) {
                    return;
                }

                traversal.skip();

                // Reference self to ensure that we see everything we're supposed to.
                // TODO: why only the first part? becuase it will reexport children?
                // Post-explicitify, is this even needed? If it's local, we'll fix it up,
                // otherwise, we're going to explicitly say which namespace and the
                // identifier check will add it.
                topLevelNamespacesToImport.add(sourceFile, nsNameParts[0]);

                // Add this file to this namespace.
                newNamespaceFiles.addFileToNamespace(sourceFile, nsNameParts);

                // We just skipped all of the namespace name parts, now go walk the body.
                body.forEachDescendant(collectReferencedNamespaces);
                return;
            }

            // In the property access or qualified name "ts.server.protocol.Message", we
            // want to check each identifier in that name; we'll do this by walking the tree,
            // so just skip anything that's not an identifier. Also, if we just reference
            // "ts", we will see just an identifier too.
            if (!Node.isIdentifier(node)) {
                return;
            }

            const parent = node.getParentOrThrow();

            // If we're our own declaration, skip; we already reference ourselves.
            if (ts.getNameOfDeclaration(parent.compilerNode as ts.Declaration) === node.compilerNode) {
                return;
            }

            const sym = checker.getSymbolAtLocation(node);
            const decls = sym && sym.getDeclarations();
            if (
                decls &&
                // Must be a namespace.
                // TS special case: no part of the namespace can be not a namespace (e.g. no merged interfaces)
                !decls.some((d) => !Node.isModuleDeclaration(d) || !(d.getFlags() & ts.NodeFlags.Namespace)) &&
                // decls.some((d) => Node.isModuleDeclaration(d) && !!(d.getFlags() & ts.NodeFlags.Namespace)) &&
                // external to the current file
                decls.some((d) => d.getSourceFile() !== sourceFile) &&
                // that are not from the `lib`
                !decls.some((d) => d.getSourceFile().getFilePath().includes("lib.")) &&
                // that are not from `node_modules`
                !decls.some((d) => d.getSourceFile().getFilePath().includes("node_modules")) &&
                // and nothing that's a class (we can't faithfully repreoduce class/ns merges anyway, so it's easy to toss these)
                !decls.some((d) => d.getKind() === ts.SyntaxKind.ClassDeclaration)
            ) {
                const nsName = checker.getFullyQualifiedName(sym);

                const isNestedNamespace = !decls.some((d) => !(d.getFlags() & ts.NodeFlags.NestedNamespace));
                if (!isNestedNamespace) {
                    // If this isn't a nested namespace, then verify that it's declared directly in
                    // a source file, so we don't accidentally create barrel files for code like:
                    //
                    // namespace ts {
                    //     export namespace ShimCollections { ... }
                    // }
                    if (decls.some((d) => !d.getParentOrThrow().isKind(ts.SyntaxKind.SourceFile))) {
                        return;
                    }
                }

                const isRHS =
                    (Node.isPropertyAccessExpression(parent) &&
                        parent.getNameNode().compilerNode === node.compilerNode) ||
                    (Node.isQualifiedName(parent) && parent.getRight().compilerNode === node.compilerNode);

                if (!isRHS) {
                    // We're on the left side of a property access expression or qualified name, e.g.
                    // in "ts.server.protocol.Message", we are in "ts". Add this to the list of top-level
                    // namespaces to import. (We want to import ts, not "ts.server" or something, as ts will
                    // reexport the server namespace).
                    topLevelNamespacesToImport.add(sourceFile, nsName);
                }

                // We do this in addition to at each namespace declaration because there can be a case where
                // a namespace is used in one project (like ts.server.protocol), but that project doesn't add
                // anything to that namespace, so it's not recorded. Make sure we do note this so we always
                // get a namespace barrel file (even if that file will be a single reexport).
                // TODO: this is broken due to projects that reference a namespace more than once via
                // other projects they depend on, e.g. this error:
                //     src/loggedIO/_namespaces/ts.server.ts:6:1 - error TS2308:
                //         Module "../../server/_namespaces/ts.server" has already exported a member named 'protocol'.
                //         Consider explicitly re-exporting to resolve the ambiguity.
                // newNamespaceFiles.ensureNamespaceFileExists(sourceFile, nsName.split("."));
            }
        }
    }

    log("creating files for fake namespaces");
    newNamespaceFiles.forEach((reexports, filename) => {
        const statements: (ExportDeclarationStructure | ImportDeclarationStructure)[] = [];
        const associatedConfig = newNamespaceFiles.findAssociatedConfig(filename);

        // TODO(jakebailey): Use ordering from references list in tsconfig.json
        const simpleConfig = configFileSet.getConfig(associatedConfig);
        assert(simpleConfig);

        const { references: dependentPaths, files: filesList } = simpleConfig;
        assert(filesList);

        dependentPaths?.forEach((requiredProjectPath) => {
            // Reexport namespace contributions of other projects listed in tsconfig,
            // e.g., in services, export everything from compiler too.
            const nsFileName = FileUtils.pathJoin(
                requiredProjectPath,
                namespacesDirName,
                FileUtils.getBaseName(filename)
            );
            if (newNamespaceFiles.has(nsFileName)) {
                statements.push({
                    kind: StructureKind.ExportDeclaration,
                    moduleSpecifier: getTsStyleRelativePath(filename, nsFileName).replace(/\.ts$/, ""),
                });
            }
        });

        // Reexport everything in this namespace.
        const reexportsSorted = Array.from(reexports).sort((a, b) => filesList.indexOf(a) - filesList.indexOf(b));
        reexportsSorted.forEach((exportingPath) => {
            statements.push({
                kind: StructureKind.ExportDeclaration,
                moduleSpecifier: getTsStyleRelativePath(filename, exportingPath).replace(/\.ts$/, ""),
            });
        });

        // Export each nested namespace as objects via:
        //     import * as bar from "./foo.bar"
        //     export { bar }
        // Note: we use this form because `export * as bar from "./foo.bar"` is not supported by api-extractor.
        // If we don't end up using it, or the feature is added, we can change this.
        const partsThis = FileUtils.getBaseName(filename)
            .slice(0, FileUtils.getBaseName(filename).length - FileUtils.getExtension(filename).length)
            .split(".");
        const currentNSName = partsThis.join(".");

        newNamespaceFiles.forEach((_, otherFilename) => {
            if (otherFilename !== filename && FileUtils.getDirPath(filename) === FileUtils.getDirPath(otherFilename)) {
                const partsOther = FileUtils.getBaseName(otherFilename)
                    .slice(
                        0,
                        FileUtils.getBaseName(otherFilename).length - FileUtils.getExtension(otherFilename).length
                    )
                    .split(".");
                const otherNSParent = partsOther.slice(0, partsOther.length - 1).join(".");
                if (otherNSParent && otherNSParent === currentNSName) {
                    statements.push({
                        kind: StructureKind.ImportDeclaration,
                        namespaceImport: partsOther[partsOther.length - 1],
                        moduleSpecifier: getTsStyleRelativePath(filename, otherFilename).replace(/\.ts$/, ""),
                    });

                    statements.push({
                        kind: StructureKind.ExportDeclaration,
                        namedExports: [
                            {
                                kind: StructureKind.ExportSpecifier,
                                name: partsOther[partsOther.length - 1],
                            },
                        ],
                    });
                }
            }
        });

        assert(statements.length > 0, `${filename} is empty`);

        const structure: SourceFileStructure = {
            kind: StructureKind.SourceFile,
            statements: statements,
        };

        const sourceFile = project.createSourceFile(filename, structure);
        sourceFile.insertStatements(0, `/* Generated file to emulate the ${currentNSName} namespace. */\r\n\r\n`);

        const configForFile = projectRootMapper.getTsConfigPath(filename);
        const projRootDir = FileUtils.getDirPath(configForFile);
        const newFileEntry = FileUtils.getRelativePathTo(projRootDir, filename);

        const configSourceFile = project.addSourceFileAtPath(configForFile);
        configSourceFile.forEachDescendant((node, traversal) => {
            if (Node.isPropertyAssignment(node)) {
                const name = node.getNameNode().asKindOrThrow(ts.SyntaxKind.StringLiteral);
                if (name.getLiteralText() === "files") {
                    const initializer = node.getInitializerIfKindOrThrow(ts.SyntaxKind.ArrayLiteralExpression);
                    initializer.addElement(`"${newFileEntry}"`);
                    traversal.stop();
                }
            }
        });
        configSourceFile.saveSync();
        project.removeSourceFile(configSourceFile);
    });

    log("fixing up interface augmentation");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (sourceFile.getFilePath().endsWith("exportAsModule.ts")) {
            // Special case; the declare here is to export as a module, which
            // we'll eventually change by hand.
            continue;
        }

        if (newNamespaceFiles.has(sourceFile.getFilePath())) {
            continue;
        }

        for (const statement of sourceFile.getStatementsWithComments()) {
            if (Node.isModuleDeclaration(statement)) {
                const { body } = skipDownToNamespaceBody(statement);
                if (!Node.isModuleBlock(body)) {
                    continue;
                }

                // TODO: rather than carrying @internal down to each declaration, emit the comment in the barrel
                // files. Direct importing is not supported for external consumers, so if api-extractor can handle
                // a @internal comment on `export * from "..."`, then this is superior to having it many many times.
                const isNamespaceInternal = isInternalDeclaration(statement, sourceFile);
                statement.getStatements().forEach((s) => visitStatementWithinNamespace(s, isNamespaceInternal));
                continue;
            }
            visitGlobalishStatement(statement);
        }

        function visitStatementWithinNamespace(statement: Statement, isNamespaceInternal: boolean) {
            const needsInternal =
                Node.isExportGetable(statement) && // If this can be exported
                statement.isExported() && // And it is exported
                !isInternalDeclaration(statement, sourceFile) && // And it's not already @internal
                isNamespaceInternal; // And we're in a workspace that is internal

            if (Node.isInterfaceDeclaration(statement)) {
                // TODO: can we just do statement.getSymbolOrThrow().getDeclarations()
                const name = statement.getNameNode();
                const sym = checker.getSymbolAtLocation(name);
                const decls = sym && sym.getDeclarations();
                if (
                    decls &&
                    decls.length > 1 &&
                    !decls.every((d) => d.getSourceFile() === decls[0].getSourceFile()) &&
                    statement !== decls[0]
                ) {
                    const sourceMappedOriginalLocation = sourceMapper.tryGetSourcePosition({
                        fileName: decls[0].getSourceFile().getFilePath(),
                        pos: decls[0].getPos(),
                    });
                    const targetFilename = sourceMappedOriginalLocation
                        ? FileUtils.getStandardizedAbsolutePath(fs, sourceMappedOriginalLocation.fileName)
                        : decls[0].getSourceFile().getFilePath();

                    const originalText = statement.getText(true);
                    statement.replaceWithText((writer) => {
                        const name = getTsStyleRelativePath(
                            sourceFile.getFilePath(),
                            targetFilename.replace(/(\.d)?\.ts$/, "") as StandardizedFilePath
                        );
                        writer
                            .conditionalWriteLine(needsInternal, "/** @internal */")
                            .write("declare module ")
                            .quote(name)
                            .write(" ")
                            .block(() => {
                                writer
                                    .writeLine("// Module transform: converted from interface augmentation")
                                    .write(originalText);
                            });
                    }, project.createWriter());
                    return;
                }
            }

            if (needsInternal) {
                const originalText = statement.getText(true);
                statement.replaceWithText((writer) => {
                    writer.writeLine("/** @internal */");
                    writer.write(originalText);
                }, project.createWriter());
            }
        }

        function visitGlobalishStatement(statement: Statement) {
            if (Node.isInterfaceDeclaration(statement) || Node.isVariableStatement(statement)) {
                const node = Node.isVariableStatement(statement)
                    ? statement.getDeclarationList().getDeclarations()[0]
                    : statement;
                const name = node.getNameNode();
                const sym = checker.getSymbolAtLocation(name);
                const decls = sym && sym.getDeclarations();

                const isMerged =
                    decls &&
                    decls.length > 1 &&
                    !decls.every((d) => d.getSourceFile() === sym.getDeclarations()?.[0].getSourceFile());
                const isAmbient = statement.hasModifier(ts.SyntaxKind.DeclareKeyword);

                if (isMerged || isAmbient) {
                    const isInternal = isInternalDeclaration(statement, sourceFile);
                    statement.setHasDeclareKeyword(false);
                    const originalText = statement.getText(true);
                    statement.replaceWithText((writer) => {
                        writer.write("declare global").block(() => {
                            writer
                                .writeLine("// Module transform: converted from ambient declaration")
                                .conditionalWriteLine(isInternal, "/** @internal */")
                                .write(originalText);
                        });
                    });
                }
            }
        }
    }

    // This must be done _after_ we screw around with any of the other contents,
    // since converting a file to a module will invalidate references to it (ts-morph
    // does bookkeeping and actively modify nodes).
    log("converting each file into a module");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (newNamespaceFiles.has(sourceFile.getFilePath())) {
            continue;
        }

        for (const statement of sourceFile.getStatementsWithComments()) {
            if (
                Node.isModuleDeclaration(statement) &&
                statement.getDeclarationKind() === ModuleDeclarationKind.Namespace
            ) {
                const { body } = skipDownToNamespaceBody(statement);
                if (!Node.isModuleBlock(body)) {
                    continue;
                }

                const previous = statement.getPreviousSibling();
                if (previous && Node.isCommentStatement(previous) && previous.getText().includes("@internal")) {
                    // TODO: if comments are fixed in main to be JSDoc and in the right place, this will not work correctly.
                    previous.remove();
                }

                // TODO: once the fix for https://github.com/dsherret/ts-morph/issues/1248 is released,
                // use statement.unwrap().
                const size = body.getStatements().length;
                if (size === 0) {
                    statement.remove();
                } else {
                    // Not getText(true), becuase that drops leading @internal comments.
                    let newText = body.getChildSyntaxListOrThrow().getFullText().trim();

                    // Prevent jsdoc style comments on top of namespaces from getting dropped.
                    const possibleJsDocs = statement.getJsDocs();
                    if (possibleJsDocs.length !== 0) {
                        assert(possibleJsDocs.length === 1);
                        newText = `${possibleJsDocs[0].getFullText()}\r\n\r\n${newText}`;
                    }

                    statement.replaceWithText(newText);
                }
            }
        }
    }

    log("adding import statements");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (newNamespaceFiles.has(sourceFile.getFilePath())) {
            continue;
        }

        const referenced = topLevelNamespacesToImport.get(sourceFile);
        if (!referenced) {
            continue;
        }

        const configFilePath = projectRootMapper.getTsConfigPath(sourceFile.getFilePath());
        const projRootDir = FileUtils.getDirPath(configFilePath);

        const imports: OptionalKind<ImportDeclarationStructure>[] = [];
        referenced.forEach((ns) => {
            const nsFilePath = getTsStyleRelativePath(
                sourceFile.getFilePath(),
                FileUtils.pathJoin(projRootDir, namespacesDirName, ns)
            );
            imports.push({
                namespaceImport: ns,
                moduleSpecifier: nsFilePath,
            });
        });

        sourceFile.insertImportDeclarations(0, imports);
    }

    log("cleaning up imports");
    for (const sourceFile of getTsSourceFiles(project)) {
        if (newNamespaceFiles.has(sourceFile.getFilePath())) {
            continue;
        }

        formatImports(sourceFile);
    }

    log("converting tsconfigs to outDir and removing prepends");
    const configsBefore = getTsConfigs(project);
    addTsConfigs(project);

    // Transform is run in TS repo root.
    const cwd = FileUtils.getStandardizedAbsolutePath(fs, process.cwd());
    const src = FileUtils.pathJoin(cwd, "src");
    const local = FileUtils.pathJoin(cwd, "built", "local");
    const localRelease = FileUtils.pathJoin(cwd, "built", "local", "release");

    for (const sourceFile of getTsConfigs(project)) {
        sourceFile.forEachDescendant((node, traversal) => {
            if (Node.isPropertyAssignment(node)) {
                const name = node.getNameNode().asKindOrThrow(ts.SyntaxKind.StringLiteral);
                switch (name.getLiteralText()) {
                    case "prepend":
                        traversal.skip();
                        node.remove();
                        return;
                    case "outFile":
                        traversal.skip();
                        node.set({
                            name: '"outDir"',
                            initializer: (writer) => {
                                // e.g. /TypeScript/src/compiler
                                const dir = sourceFile.getDirectoryPath();

                                // e.g. compiler
                                const projectPath = FileUtils.getRelativePathTo(src, dir);

                                const builtLocal = sourceFile.getBaseName().includes(".release.")
                                    ? localRelease
                                    : local;

                                // e.g. ../../built/local
                                const relativeToBuilt = FileUtils.getRelativePathTo(dir, builtLocal);

                                // TODO: figure out why we emit to a subdir; point to the built dir for now instead.
                                // e.g. ../../built/local/compiler
                                // const outDir = FileUtils.pathJoin(relativeToBuilt, projectPath);

                                writer.quote(relativeToBuilt);
                            },
                        });
                }
            }
        });

        sourceFile.saveSync();
        if (!configsBefore.includes(sourceFile)) {
            project.removeSourceFile(sourceFile);
        }
    }
}
