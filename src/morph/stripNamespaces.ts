import { FileUtils, StandardizedFilePath } from "@ts-morph/common";
import assert from "assert";
import {
    ClassDeclaration,
    CompilerNodeToWrappedType,
    ExportDeclarationStructure,
    FileSystemHost,
    ForEachDescendantTraversalControl,
    ImportDeclarationStructure,
    ModuleBlock,
    ModuleDeclaration,
    Node,
    Project,
    SourceFile,
    SourceFileStructure,
    Statement,
    StructureKind,
    ts,
} from "ts-morph";

import { ProjectTransformerConfig } from "..";
import { getSourceFilesFromProject } from "./helpers";
import { getTSStyleRelativePath } from "./pathUtil";
import * as tsInternal from "./tsInternal";

// TODO: do I need this?
function getNodeFromCompilerNode<LocalCompilerNodeType extends ts.Node = ts.Node>(
    someNodeInTree: Node,
    compilerNode: LocalCompilerNodeType
): CompilerNodeToWrappedType<LocalCompilerNodeType> {
    // Sorry.
    return (someNodeInTree as any)._context.compilerFactory.getNodeFromCompilerNode(
        compilerNode,
        (someNodeInTree as any)._sourceFile
    );
}

function isMarkedInternal(node: Node, sourceFile = node.getSourceFile()): boolean {
    return (
        !!tsInternal.isInternalDeclaration(node.compilerNode, sourceFile.compilerNode) &&
        tsInternal.hasSyntacticModifier(node.compilerNode, ts.ModifierFlags.Export)
    );
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
    // What we actually have to do:
    // - Collect a list of namespaces used (produced by explicitify)
    // - Create files for those namespaces
    // - Remove outer namespace and transfer @internal comments downward
    // - Import those files
    // - Modify the tsconfigs to add the new files

    const fs = project.getFileSystem();
    // Tracks which namespaces each source file uses.
    const referencedNamespaceSet = createReferencedNamespaceSet();
    // Gets the project config path for a file (since we are loading this as one project)
    const projectRootMapper = createProjectRootMapper(fs);
    // Tracks newly added namespace files.
    const newNamespaceFiles = createNamespaceFileSet(fs, projectRootMapper);
    // Tracks which configs reference which other configs.
    const configDependencySet = createConfigDependencySet(fs, projectRootMapper);

    const checker = project.getTypeChecker();

    // Step 1: Collect references to used namespaces.
    console.log("\tcollecting references to used namespaces");
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
            if (tsInternal.getNameOfDeclaration(parent.compilerNode as ts.Declaration) === node.compilerNode) {
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
                const nsName = tsInternal.symbolToString(checker.compilerObject, sym.compilerSymbol);
                referencedNamespaceSet.add(sourceFile, nsName);
            }
        }
    }

    // Step 2: Create files for fake namespaces
    console.log("\tcreating files for fake namespaces");
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

        project.createSourceFile(filename, structure);
    });

    // Step 3: Convert each file into a module with exports
    console.log("\tconverting each file into a module");
    // TODO: add @internal comments
    // TODO: once the fix for https://github.com/dsherret/ts-morph/issues/1248 is released,
    // use statement.unwrap().
    for (const sourceFile of getSourceFilesFromProject(project)) {
        for (const statement of sourceFile.getStatementsWithComments()) {
            if (Node.isModuleDeclaration(statement)) {
                const { body } = skipDownToNamespaceBody(statement);
                if (!Node.isModuleBlock(body)) {
                    continue;
                }
                const newText = body.getChildSyntaxListOrThrow().getFullText();
                statement.replaceWithText(newText);
            }
        }
    }

    function visitStatements(statement: Statement) {
        if (
            Node.isModuleDeclaration(statement) &&
            !Node.isStringLiteral(statement.getNameNode()) &&
            statement.getBody()
        ) {
            const { body } = skipDownToNamespaceBody(statement);
            if (!Node.isModuleBlock(body)) {
                return;
            }

            const isInternal = isMarkedInternal(statement);

            // body.forEachChildAsArray();

            // body.getStatements().forEach((s) => visitStatement(statement, isInternal));

            return;
        }

        visitGlobalishStateemnt(statement);
    }

    function visitStatement(statement: Statement, isInternal: boolean) {
        visitIdentifiers(statement);
    }

    function visitGlobalishStateemnt(statement: Statement) {}

    function visitIdentifiers(node: Node) {}
}
