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

import { getSourceFilesFromProject } from "./helpers";
import { log } from "./logging";
import { getTSStyleRelativePath } from "./pathUtil";

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

function createReferencedNamespaceSet() {
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

function createNamespaceFileSet(projectRootMapper: ProjectRootMapper) {
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

    return {
        addFileToNamespace(sourceFile: SourceFile, nsPath: NamespaceNameParts) {
            const sourceFilePath = sourceFile.getFilePath();
            const configFilePath = projectRootMapper.getTsConfigPath(sourceFilePath);
            const projRootDir = FileUtils.getDirPath(configFilePath);

            const nsFilePath = FileUtils.pathJoin(projRootDir, namespacePartsToFilename(nsPath));
            getOrCreate({
                namespaceFilePath: nsFilePath,
                configFilePath,
            }).add(sourceFilePath);

            for (let i = 1; i < nsPath.length; i++) {
                const parentNsFile = FileUtils.pathJoin(projRootDir, namespacePartsToFilename(nsPath.slice(0, i)));
                getOrCreate({
                    namespaceFilePath: parentNsFile,
                    configFilePath,
                });
            }
        },
        has: newNamespaceFiles.has.bind(newNamespaceFiles),
        forEach: newNamespaceFiles.forEach.bind(newNamespaceFiles),
        findAssociatedConfig(path: StandardizedFilePath) {
            return [...extraFilesFieldMembers.entries()].find(([_, addedFiles]) => addedFiles.has(path))![0];
        },
    };
}

function createConfigDependencySet(fs: FileSystemHost, projectRootMapper: ProjectRootMapper) {
    const configDeps = new Map<StandardizedFilePath, Set<StandardizedFilePath> | undefined>();

    return {
        add(sourceFile: SourceFile) {
            const sourceFilePath = sourceFile.getFilePath();
            const configFilePath = projectRootMapper.getTsConfigPath(sourceFilePath);
            const projRootDir = FileUtils.getDirPath(configFilePath);

            if (configDeps.has(configFilePath)) {
                return;
            }

            const config: { references?: { path: string }[] } = ts.readConfigFile(
                configFilePath,
                fs.readFileSync
            ).config;

            const refSet = config.references
                ? new Set(config.references.map((r) => FileUtils.getStandardizedAbsolutePath(fs, r.path, projRootDir)))
                : undefined;

            configDeps.set(configFilePath, refSet);
        },
        get: configDeps.get.bind(configDeps),
    };
}

export function stripNamespaces(project: Project): void {
    const fs = project.getFileSystem();
    // Tracks which namespaces each source file uses.
    const referencedNamespaceSet = createReferencedNamespaceSet();
    // Gets the project config path for a file (since we are loading this as one project)
    const projectRootMapper = createProjectRootMapper(fs);
    // Tracks newly added namespace files.
    const newNamespaceFiles = createNamespaceFileSet(projectRootMapper);
    // Tracks which configs reference which other configs.
    const configDependencySet = createConfigDependencySet(fs, projectRootMapper);

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

    // Step 1: Collect references to used namespaces.
    log("collecting references to used namespaces");
    for (const sourceFile of getSourceFilesFromProject(project)) {
        configDependencySet.add(sourceFile);

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
                referencedNamespaceSet.add(sourceFile, nsNameParts[0]);

                newNamespaceFiles.addFileToNamespace(sourceFile, nsNameParts);

                // We just skipped all of the namespace name parts, now go walk the body.
                body.forEachDescendant(collectReferencedNamespaces);
                return;
            }

            if (!Node.isIdentifier(node)) {
                return;
            }

            const parent = node.getParentOrThrow();
            if (ts.getNameOfDeclaration(parent.compilerNode as ts.Declaration) === node.compilerNode) {
                return;
            }

            if (Node.isPropertyAccessExpression(parent) && parent.getNameNode().compilerNode === node.compilerNode) {
                return;
            }

            if (Node.isQualifiedName(parent) && parent.getRight().compilerNode === node.compilerNode) {
                return;
            }

            const sym = checker.getSymbolAtLocation(node);
            const decls = sym && sym.getDeclarations();
            if (
                decls &&
                // Must be a namespace.
                decls.some((d) => Node.isModuleDeclaration(d) && !!(d.getFlags() & ts.NodeFlags.Namespace)) &&
                // external to the current file
                decls.some((d) => d.getSourceFile() !== sourceFile) &&
                // that are not from the `lib`
                !decls.some((d) => d.getSourceFile().getFilePath().includes("lib.")) &&
                // that are not from `node_modules`
                !decls.some((d) => d.getSourceFile().getFilePath().includes("node_modules")) &&
                // and nothing that's a class (we can't faithfully repreoduce class/ns merges anyway, so it's easy to toss these)
                !decls.some((d) => d.getKind() === ts.SyntaxKind.ClassDeclaration)
            ) {
                const nsName = checker.compilerObject.symbolToString(sym.compilerSymbol);
                referencedNamespaceSet.add(sourceFile, nsName);
            }
        }
    }

    // Step 2: Create files for fake namespaces
    log("creating files for fake namespaces");
    newNamespaceFiles.forEach((reexports, filename) => {
        const reexportStatements: (ExportDeclarationStructure | ImportDeclarationStructure)[] = [];
        const associatedConfig = newNamespaceFiles.findAssociatedConfig(filename);

        const dependentPaths = configDependencySet.get(associatedConfig);
        dependentPaths?.forEach((requiredProjectPath) => {
            const nsFileName = FileUtils.pathJoin(requiredProjectPath, FileUtils.getBaseName(filename));
            if (newNamespaceFiles.has(nsFileName)) {
                reexportStatements.push({
                    kind: StructureKind.ExportDeclaration,
                    moduleSpecifier: getTSStyleRelativePath(filename, nsFileName).replace(/\.ts$/, ""),
                });
            }
        });

        reexports.forEach((exportingPath) => {
            reexportStatements.push({
                kind: StructureKind.ExportDeclaration,
                moduleSpecifier: getTSStyleRelativePath(filename, exportingPath).replace(/\.ts$/, ""),
            });
        });

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
                    reexportStatements.push({
                        kind: StructureKind.ImportDeclaration,
                        namespaceImport: partsOther[partsOther.length - 1],
                        moduleSpecifier: getTSStyleRelativePath(filename, otherFilename).replace(/\.ts$/, ""),
                    });

                    reexportStatements.push({
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

        const structure: SourceFileStructure = {
            kind: StructureKind.SourceFile,
            statements: reexportStatements,
        };

        const sourceFile = project.createSourceFile(filename, structure);
        sourceFile.insertStatements(0, `/* Generated file to enumate the ${currentNSName} namespace. */`);

        const configForFile = projectRootMapper.getTsConfigPath(filename);
        const configSourceFile = project.addSourceFileAtPath(configForFile);
        configSourceFile.forEachDescendant((node, traversal) => {
            if (Node.isPropertyAssignment(node) && node.getName() === '"files"') {
                const initializer = node.getInitializerIfKindOrThrow(ts.SyntaxKind.ArrayLiteralExpression);
                initializer.addElement(`"${FileUtils.getBaseName(filename)}"`);
                traversal.stop();
            }
        });
        configSourceFile.saveSync();
        project.removeSourceFile(configSourceFile);
    });

    // Step 3: Fix up interface augmentation
    log("fixing up interface augmentation");
    for (const sourceFile of getSourceFilesFromProject(project)) {
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
                        const name = getTSStyleRelativePath(
                            sourceFile.getFilePath(),
                            targetFilename.replace(/(\.d)?\.ts$/, "") as StandardizedFilePath
                        );
                        writer
                            .conditionalWriteLine(needsInternal, "/* @internal */")
                            .write("declare module")
                            .quote(name)
                            .write(" ")
                            .block(() => {
                                writer
                                    .writeLine("// Module transform: converted from interface augmentation")
                                    .write(originalText);
                            });
                    });
                    return;
                }
            }

            if (needsInternal) {
                const originalText = statement.getText(true);
                statement.replaceWithText((writer) => {
                    writer.writeLine("/* @internal */");
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
                                .conditionalWriteLine(isInternal, "/* @internal */")
                                .write(originalText);
                        });
                    });
                }
            }
        }
    }

    // Step 4: Convert each file into a module with exports
    // This must be done _after_ we screw around with any of the other contents,
    // since converting a file to a module will invalidate references to it (ts-morph
    // does bookkeeping and actively modify nodes).
    log("converting each file into a module");
    for (const sourceFile of getSourceFilesFromProject(project)) {
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
                    previous.remove();
                }

                // TODO: once the fix for https://github.com/dsherret/ts-morph/issues/1248 is released,
                // use statement.unwrap().
                const size = body.getStatements().length;
                if (size === 0) {
                    statement.remove();
                } else {
                    // Not getText(true), becuase that drops leading @internal comments.
                    const newText = body.getChildSyntaxListOrThrow().getFullText().trim();
                    statement.replaceWithText(newText);
                }
            }
        }
    }

    // Step 5: Add import statements.
    log("adding import statements");
    for (const sourceFile of getSourceFilesFromProject(project)) {
        if (newNamespaceFiles.has(sourceFile.getFilePath())) {
            continue;
        }

        const referenced = referencedNamespaceSet.get(sourceFile);
        if (!referenced) {
            continue;
        }

        const configFilePath = projectRootMapper.getTsConfigPath(sourceFile.getFilePath());
        const projRootDir = FileUtils.getDirPath(configFilePath);

        const imports: OptionalKind<ImportDeclarationStructure>[] = [];
        referenced.forEach((ns) => {
            const nsFilePath = getTSStyleRelativePath(sourceFile.getFilePath(), FileUtils.pathJoin(projRootDir, ns));
            imports.push({
                namespaceImport: ns,
                moduleSpecifier: nsFilePath,
            });
        });

        sourceFile.insertImportDeclarations(0, imports);

        // Remove unused imports.
        sourceFile.organizeImports();
        if (sourceFile.getExportSymbols().length === 0) {
            // organizeImports was too strong, add an empty export to make sure this is a module.
            sourceFile.addExportDeclarations([{}]);
        }
    }

    // TODO: update prepend and outFile
}
